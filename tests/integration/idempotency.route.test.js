jest.mock("../../src/services/hubspot.client", () => ({ request: jest.fn() }));
jest.mock("../../src/services/teachableCourses.client", () => ({ request: jest.fn() }));

const request = require("supertest");
const { buildEnrollmentCompletedPayload } = require("../fixtures/enrollmentCompletedPayload");
const { isParticipationsLookup, attendedParticipation } = require("../helpers/hubspotMocks");

const SECRET = process.env.TEACHABLE_WEBHOOK_PATH_SECRET;
const webhookUrl = () => `/webhooks/teachable/${SECRET}`;

let app;
let hubspotClient;
let teachableClient;
let idempotencyStore;

const reload = () => {
  jest.resetModules();
  hubspotClient = require("../../src/services/hubspot.client");
  teachableClient = require("../../src/services/teachableCourses.client");
  idempotencyStore = require("../../src/services/idempotencyStore");
  app = require("../../src/app");
};

const mockCourseFound = () =>
  teachableClient.request.mockImplementation(async ({ url }) => {
    const [, id] = url.match(/\/courses\/(\d+)/) || [];
    return { data: { course: { id: Number(id), name: `Course ${id}` } }, status: 200 };
  });

describe("Idempotency and duplicate-delivery handling", () => {
  beforeEach(() => {
    delete process.env.MAX_PROCESSING_ATTEMPTS;
    reload();
    mockCourseFound();
  });

  test("an exact duplicate redelivery of a SUCCEEDED enrollment makes no further HubSpot calls", async () => {
    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        return { data: { results: [{ id: "1" }], total: 1 }, status: 200 };
      }
      if (url.endsWith("/identifiers")) {
        return { data: { total: 0, results: [] }, status: 200 };
      }
      if (isParticipationsLookup(url)) {
        return { data: attendedParticipation(), status: 200 };
      }
      if (url === "/marketing/v3/marketing-events/events") {
        return { data: { objectId: "evt-1" }, status: 200 };
      }
      return { data: { results: [{ vid: 1, email: "a@b.com" }] }, status: 200 };
    });
    const payload = buildEnrollmentCompletedPayload();

    const res1 = await request(app).post(webhookUrl()).send(payload);
    expect(res1.body.status).toBe("SUCCEEDED");
    const callsAfterFirst = hubspotClient.request.mock.calls.length;

    const res2 = await request(app).post(webhookUrl()).send(payload);
    expect(res2.body.status).toBe("SUCCEEDED");
    expect(hubspotClient.request.mock.calls.length).toBe(callsAfterFirst);
  });

  test("concurrent duplicate deliveries result in exactly one attendance write", async () => {
    let attendanceCalls = 0;
    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        return { data: { results: [{ id: "1" }], total: 1 }, status: 200 };
      }
      if (url.endsWith("/identifiers")) {
        return { data: { total: 0, results: [] }, status: 200 };
      }
      if (isParticipationsLookup(url)) {
        return { data: attendedParticipation(), status: 200 };
      }
      if (url === "/marketing/v3/marketing-events/events") {
        return { data: { objectId: "evt-1" }, status: 200 };
      }
      attendanceCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { data: { results: [{ vid: 1, email: "a@b.com" }] }, status: 200 };
    });
    const payload = buildEnrollmentCompletedPayload();

    const [res1, res2] = await Promise.all([
      request(app).post(webhookUrl()).send(payload),
      request(app).post(webhookUrl()).send(payload),
    ]);

    const statuses = [res1.body.status, res2.body.status];
    expect(statuses).toContain("SUCCEEDED");
    expect(attendanceCalls).toBe(1);
  });

  test("a FAILED_RETRYABLE enrollment succeeds once redelivered", async () => {
    let searchCallCount = 0;
    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        searchCallCount += 1;
        if (searchCallCount === 1) {
          throw Object.assign(new Error("rate limited"), {
            statusCode: 429,
            errorCode: "RATE_LIMITED",
            retryable: true,
          });
        }
        return { data: { results: [{ id: "1" }], total: 1 }, status: 200 };
      }
      if (url.endsWith("/identifiers")) {
        return { data: { total: 0, results: [] }, status: 200 };
      }
      if (isParticipationsLookup(url)) {
        return { data: attendedParticipation(), status: 200 };
      }
      if (url === "/marketing/v3/marketing-events/events") {
        return { data: { objectId: "evt-1" }, status: 200 };
      }
      return { data: { results: [{ vid: 1, email: "a@b.com" }] }, status: 200 };
    });
    const payload = buildEnrollmentCompletedPayload();

    const res1 = await request(app).post(webhookUrl()).send(payload);
    expect(res1.status).toBe(503);
    expect(res1.body.status).toBe("FAILED_RETRYABLE");

    const res2 = await request(app).post(webhookUrl()).send(payload);
    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe("SUCCEEDED");
  });

  test("redelivery after the retry budget is exhausted becomes a pure no-op", async () => {
    process.env.MAX_PROCESSING_ATTEMPTS = "2";
    reload();
    mockCourseFound();

    const err = Object.assign(new Error("rate limited"), {
      statusCode: 429,
      errorCode: "RATE_LIMITED",
      retryable: true,
    });
    hubspotClient.request.mockRejectedValue(err);
    const payload = buildEnrollmentCompletedPayload();

    const res1 = await request(app).post(webhookUrl()).send(payload); // attempt 1/2 -> retryable
    expect(res1.body.status).toBe("FAILED_RETRYABLE");

    const res2 = await request(app).post(webhookUrl()).send(payload); // attempt 2/2 -> exhausted
    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe("FAILED_PERMANENT");

    const callsAfterExhaustion = hubspotClient.request.mock.calls.length;

    const res3 = await request(app).post(webhookUrl()).send(payload); // pure no-op
    expect(res3.body.status).toBe("FAILED_PERMANENT");
    expect(hubspotClient.request.mock.calls.length).toBe(callsAfterExhaustion);
  });

  test("a stale PROCESSING record left behind by a crash/hang is reclaimed and completed on redelivery", async () => {
    const payload = buildEnrollmentCompletedPayload();

    // Simulate a request that claimed the enrollment and then never finished
    // (crash, or an unhandled hang) within this same process.
    const { record } = idempotencyStore.claim(payload.object.id, {
      maxAttempts: 5,
      staleProcessingTimeoutMs: 5 * 60 * 1000,
    });
    record.updatedAt = Date.now() - 10 * 60 * 1000;

    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        return { data: { results: [{ id: "1" }], total: 1 }, status: 200 };
      }
      if (url.endsWith("/identifiers")) {
        return { data: { total: 0, results: [] }, status: 200 };
      }
      if (isParticipationsLookup(url)) {
        return { data: attendedParticipation(), status: 200 };
      }
      if (url === "/marketing/v3/marketing-events/events") {
        return { data: { objectId: "evt-1" }, status: 200 };
      }
      return { data: { results: [{ vid: 1, email: "a@b.com" }] }, status: 200 };
    });

    const res = await request(app).post(webhookUrl()).send(payload);
    expect(res.body.status).toBe("SUCCEEDED");
  });

  // HubSpot's attendance write is only idempotent for an unchanged
  // (contact, interactionDateTime) pair. The timestamp comes from a live
  // Teachable lookup that can fall back, so two attempts at the same enrollment
  // could otherwise write two differently-timestamped participation records.
  test("a retry re-sends the timestamp pinned by the first attempt, not a freshly resolved one", async () => {
    const FIRST_COMPLETED_AT = "2026-09-17T05:27:52Z";
    const LATER_COMPLETED_AT = "2026-09-17T09:15:31Z";
    let completedAt = FIRST_COMPLETED_AT;

    teachableClient.request.mockImplementation(async ({ url }) => {
      if (url.endsWith("/progress")) {
        return { data: { course_progress: { completed_at: completedAt } }, status: 200 };
      }
      return { data: { course: { id: 101, name: "Course 101" } }, status: 200 };
    });

    let failAttendance = true;
    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        return { data: { results: [{ id: "1" }], total: 1 }, status: 200 };
      }
      if (url.endsWith("/identifiers")) {
        return { data: { total: 0, results: [] }, status: 200 };
      }
      if (isParticipationsLookup(url)) {
        return { data: attendedParticipation(), status: 200 };
      }
      if (url === "/marketing/v3/marketing-events/events") {
        return { data: { objectId: "evt-1" }, status: 200 };
      }
      if (failAttendance) {
        throw Object.assign(new Error("rate limited"), {
          statusCode: 429,
          errorCode: "RATE_LIMITED",
          retryable: true,
        });
      }
      return { data: { results: [{ vid: 1, email: "a@b.com" }] }, status: 200 };
    });
    const payload = buildEnrollmentCompletedPayload();

    const first = await request(app).post(webhookUrl()).send(payload);
    expect(first.status).toBe(503);

    // Teachable now reports a different completion time, and the write succeeds.
    completedAt = LATER_COMPLETED_AT;
    failAttendance = false;
    const second = await request(app).post(webhookUrl()).send(payload);
    expect(second.body.status).toBe("SUCCEEDED");

    const attendanceBodies = hubspotClient.request.mock.calls
      .map(([cfg]) => cfg)
      .filter((cfg) => cfg.url.includes("/attendance/"))
      .map((cfg) => cfg.data.inputs[0]);

    expect(attendanceBodies).toHaveLength(2);
    expect(attendanceBodies[1].interactionDateTime).toBe(attendanceBodies[0].interactionDateTime);
    expect(attendanceBodies[1].interactionDateTime).toBe(Date.parse(FIRST_COMPLETED_AT));
    expect(attendanceBodies[1].properties).toEqual(attendanceBodies[0].properties);
    // The second attempt never re-asked Teachable for a timestamp.
    expect(
      teachableClient.request.mock.calls.filter(([cfg]) => cfg.url.endsWith("/progress")),
    ).toHaveLength(1);
  });

  test("state does not survive a process restart, but replaying a succeeded enrollment is a harmless no-op", async () => {
    // This documents the accepted trade-off of the in-memory store: HubSpot's
    // attendance endpoint is idempotent per (contact, interactionDateTime), so
    // losing in-memory state on restart cannot create a duplicate attendance
    // record — HubSpot itself absorbs the redundant call.
    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        return { data: { results: [{ id: "1" }], total: 1 }, status: 200 };
      }
      if (url.endsWith("/identifiers")) {
        return { data: { total: 0, results: [] }, status: 200 };
      }
      if (isParticipationsLookup(url)) {
        return { data: attendedParticipation(), status: 200 };
      }
      if (url === "/marketing/v3/marketing-events/events") {
        return { data: { objectId: "evt-1" }, status: 200 };
      }
      return { data: { results: [{ vid: 1, email: "a@b.com" }] }, status: 200 };
    });
    const payload = buildEnrollmentCompletedPayload();

    const res1 = await request(app).post(webhookUrl()).send(payload);
    expect(res1.body.status).toBe("SUCCEEDED");

    reload(); // simulates a process restart: fresh in-memory store, fresh app
    mockCourseFound();
    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        return { data: { results: [{ id: "1" }], total: 1 }, status: 200 };
      }
      if (url.endsWith("/identifiers")) {
        return { data: { total: 0, results: [] }, status: 200 };
      }
      if (isParticipationsLookup(url)) {
        return { data: attendedParticipation(), status: 200 };
      }
      if (url === "/marketing/v3/marketing-events/events") {
        return { data: { objectId: "evt-1" }, status: 200 };
      }
      return { data: { results: [{ vid: 1, email: "a@b.com" }] }, status: 200 };
    });

    const res2 = await request(app).post(webhookUrl()).send(payload);
    expect(res2.body.status).toBe("SUCCEEDED"); // reprocessed, not blocked -- but safe, since HubSpot no-ops it
  });
});
