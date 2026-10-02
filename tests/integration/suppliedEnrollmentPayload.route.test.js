jest.mock("../../src/services/hubspot.client", () => ({ request: jest.fn() }));
jest.mock("../../src/services/teachableCourses.client", () => ({ request: jest.fn() }));

const request = require("supertest");
const { isParticipationsLookup, attendedParticipation } = require("../helpers/hubspotMocks");

const PARTICIPATION_STORED = attendedParticipation({
  externalEventId: "2968746",
  marketingEventId: "evt-2968746",
  contactId: "551",
  email: "test@email.com",
});

const SECRET = process.env.TEACHABLE_WEBHOOK_PATH_SECRET;
const webhookUrl = () => `/webhooks/teachable/${SECRET}`;

let app;
let hubspotClient;
let teachableClient;
let idempotencyStore;
let logger;

const reload = () => {
  jest.resetModules();
  hubspotClient = require("../../src/services/hubspot.client");
  teachableClient = require("../../src/services/teachableCourses.client");
  idempotencyStore = require("../../src/services/idempotencyStore");
  logger = require("../../src/utils/logger");
  app = require("../../src/app");
};

const warnings = () => logger.warn.mock.calls.map(([message]) => message);

/**
 * The verbatim Enrollment.completed delivery supplied by the client as the
 * source of truth for the Teachable -> HubSpot mapping. Kept literal (not
 * generated from the fixture builder) precisely so that a future change to the
 * shared fixture cannot quietly change what this test asserts.
 *
 * Note it carries no `completed_at` — see resolveCompletionTimestamp().
 */
const SUPPLIED_PAYLOAD = {
  type: "Enrollment.completed",
  id: 1186296825,
  livemode: true,
  created: "2026-09-16T13:05:01+00:00",
  hook_event_id: 879962887,
  object: {
    id: 1186296825,
    user_id: 130785911,
    course_id: 2968746,
    primary_course_id: 2968746,
    course_progress_id: 1750540611,
    sale_id: null,
    is_active: true,
    percent_complete: 100.0,
    enrolled_at: "2026-09-16T13:04:55Z",
    created_at: "2026-09-16T13:04:55Z",
    updated_at: "2026-09-16T13:04:55Z",
    user: {
      id: 130785911,
      email: "test@email.com",
      name: "test",
      phone_number: null,
    },
    course: {
      id: 2968746,
      name: "Cab Rack and Accessory Overview Training",
      url: "https://herd-training.teachable.com/courses/2968746",
      friendly_url: "/courses/cab-rack-and-accessory-overview-training",
    },
  },
};

const callsTo = (matcher) =>
  hubspotClient.request.mock.calls.map(([cfg]) => cfg).filter((cfg) => matcher(cfg));

const TEACHABLE_COMPLETED_AT = "2026-09-16T13:07:12Z";

/**
 * Teachable serves the course record and the learner's course progress from
 * two different endpoints; only the second carries completed_at.
 */
const mockTeachable = (progressOverrides) =>
  teachableClient.request.mockImplementation(async ({ url }) => {
    if (url.endsWith("/progress")) {
      // Nested under `course_progress` and accompanied by `meta`, matching the
      // live API response verified 2026-09-17 — not the flat shape the
      // published schema documents.
      const progress = { completed_at: TEACHABLE_COMPLETED_AT, percent_complete: 100 };
      // `omitCompletedAt` distinguishes "field absent" from "explicitly null",
      // which a default parameter value cannot express.
      if (progressOverrides?.omitCompletedAt) delete progress.completed_at;
      else if (progressOverrides && "completedAt" in progressOverrides) {
        progress.completed_at = progressOverrides.completedAt;
      }
      return { data: { course_progress: progress, meta: { total: 1 } }, status: 200 };
    }
    return {
      data: { course: { id: 2968746, name: "Cab Rack and Accessory Overview Training" } },
      status: 200,
    };
  });

describe("the supplied Enrollment.completed payload, end to end", () => {
  beforeEach(() => {
    reload();
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    mockTeachable();
    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        return { data: { results: [{ id: "551" }], total: 1 }, status: 200 };
      }
      if (url.endsWith("/identifiers")) return { data: { total: 0, results: [] }, status: 200 };
      if (url === "/marketing/v3/marketing-events/events") {
        return { data: { objectId: "evt-2968746" }, status: 200 };
      }
      if (isParticipationsLookup(url)) {
        return { data: PARTICIPATION_STORED, status: 200 };
      }
      if (url.includes("/attendance/")) {
        return { data: { results: [{ vid: 551, email: "test@email.com" }] }, status: 200 };
      }
      throw new Error(`Unexpected HubSpot call in test: ${url}`);
    });
  });

  test("succeeds and records the enrollment against the right contact and event", async () => {
    const res = await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCEEDED");
    // Enrollment ID (object.id) — NOT hook_event_id (879962887).
    expect(res.body.enrollmentId).toBe(1186296825);
    const record = idempotencyStore.get(1186296825);
    expect(record.status).toBe("SUCCEEDED");
    expect(record.hubspotContactId).toBe("551");
    expect(idempotencyStore.get(879962887)).toBeUndefined();
  });

  test("matches the Contact on object.user.email and nothing else", async () => {
    await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    const [search] = callsTo((c) => c.url === "/crm/v3/objects/contacts/search");
    expect(search.data.filterGroups).toEqual([
      { filters: [{ propertyName: "email", operator: "EQ", value: "test@email.com" }] },
    ]);
    // No Contact is ever written: user.name is not split into firstname/lastname
    // and phone_number is not mapped.
    expect(callsTo((c) => c.method === "PATCH" && c.url.includes("/contacts"))).toHaveLength(0);
    expect(callsTo((c) => c.method === "POST" && c.url === "/crm/v3/objects/contacts")).toHaveLength(
      0,
    );
  });

  test("uses course_id 2968746 as hs_external_event_id and course.name as hs_event_name", async () => {
    await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    expect(teachableClient.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/courses/2968746" }),
    );

    const [create] = callsTo((c) => c.url === "/marketing/v3/marketing-events/events");
    expect(create.data).toEqual({
      externalEventId: "2968746",
      externalAccountId: "test-account",
      eventName: "Cab Rack and Accessory Overview Training",
      eventOrganizer: "Teachable",
    });
  });

  test("never writes a calculated, read-only or requirement-less event property", async () => {
    await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    const forbidden = [
      "hs_unique_id",
      "hs_object_id",
      "hs_createdate",
      "hs_lastmodifieddate",
      "hs_event_status",
      "hs_event_status_v2",
      "eventUrl",
      "eventDescription",
      "eventType",
      "startDateTime",
      "endDateTime",
      "eventCompleted",
    ];
    const everyBody = JSON.stringify(hubspotClient.request.mock.calls);
    for (const property of forbidden) {
      expect(everyBody).not.toContain(property);
    }
    // ...and the /complete endpoint is never called.
    expect(callsTo((c) => c.url.endsWith("/complete"))).toHaveLength(0);
  });

  test("records ATTENDED participation at Teachable's own completed_at", async () => {
    await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    expect(teachableClient.request).toHaveBeenCalledWith({
      method: "GET",
      url: "/courses/2968746/progress",
      params: { user_id: 130785911 },
    });

    const [attendance] = callsTo((c) => c.url.includes("/attendance/"));
    expect(attendance.url).toBe(
      "/marketing/v3/marketing-events/attendance/2968746/attend/email-create",
    );
    expect(attendance.params).toEqual({ externalAccountId: "test-account" });
    expect(attendance.data).toEqual({
      inputs: [
        {
          email: "test@email.com",
          // Teachable's authoritative completed_at, NOT the payload's
          // updated_at (13:04:55) and not enrolled_at.
          interactionDateTime: Date.parse(TEACHABLE_COMPLETED_AT),
          // Without populated joinedAt/leftAt, HubSpot returns 200 and records
          // nothing at all. A course completion has no session duration, so
          // the span is the smallest one HubSpot actually stores.
          properties: {
            joinedAt: new Date(TEACHABLE_COMPLETED_AT).toISOString(),
            // +1 SECOND, not +1ms: attendanceDurationSeconds is an integer
            // number of seconds, and a span that rounds down to 0 is accepted
            // with a populated results array and then silently discarded.
            leftAt: new Date(Date.parse(TEACHABLE_COMPLETED_AT) + 1000).toISOString(),
          },
        },
      ],
    });
  });

  test("never sends an attend call without populated joinedAt/leftAt", async () => {
    await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    const [attendance] = callsTo((c) => c.url.includes("/attendance/"));
    const input = attendance.data.inputs[0];
    expect(input.properties).toBeDefined();
    expect(input.properties.joinedAt).toBeTruthy();
    expect(input.properties.leftAt).toBeTruthy();
    expect(Date.parse(input.properties.leftAt)).toBeGreaterThan(
      Date.parse(input.properties.joinedAt),
    );
    expect(typeof input.interactionDateTime).toBe("number");
  });

  test("sends completed_at as epoch milliseconds, not seconds or an ISO string", async () => {
    await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    const [attendance] = callsTo((c) => c.url.includes("/attendance/"));
    const sent = attendance.data.inputs[0].interactionDateTime;

    expect(typeof sent).toBe("number");
    expect(sent).toBe(1789564032000);
    expect(String(sent)).toHaveLength(13);
    expect(sent).not.toBe(Math.floor(Date.parse(TEACHABLE_COMPLETED_AT) / 1000));
    // No warning on the authoritative path.
    expect(warnings()).toHaveLength(0);
  });

  test.each([
    ["completed_at is null", { completedAt: null }],
    ["completed_at is absent", { omitCompletedAt: true }],
    ["completed_at is malformed", { completedAt: "not-a-date" }],
  ])("falls back to the payload-derived timestamp when %s", async (_label, overrides) => {
    mockTeachable(overrides);

    const res = await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    expect(res.body.status).toBe("SUCCEEDED");
    const [attendance] = callsTo((c) => c.url.includes("/attendance/"));
    // object.updated_at, per the documented fallback chain.
    expect(attendance.data.inputs[0].interactionDateTime).toBe(
      Date.parse("2026-09-16T13:04:55Z"),
    );
    expect(warnings().join(" ")).toMatch(/completed_at|progress/i);
  });

  test("a failing progress lookup falls back rather than failing the enrollment", async () => {
    teachableClient.request.mockImplementation(async ({ url }) => {
      if (url.endsWith("/progress")) {
        throw Object.assign(new Error("Teachable API Error: rate limited"), {
          errorCode: "RATE_LIMITED",
          retryable: true,
        });
      }
      return {
        data: { course: { id: 2968746, name: "Cab Rack and Accessory Overview Training" } },
        status: 200,
      };
    });

    const res = await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCEEDED");
    const [attendance] = callsTo((c) => c.url.includes("/attendance/"));
    expect(attendance.data.inputs[0].interactionDateTime).toBe(
      Date.parse("2026-09-16T13:04:55Z"),
    );
    expect(warnings().join(" ")).toMatch(/progress lookup failed/i);
  });

  // email-create creates a contact when the email is unknown to HubSpot, which
  // the SOW forbids. The NOT_FOUND guard ahead of it is what prevents that, so
  // the ordering is load-bearing.
  test("never reaches the contact-creating attendance call for an unknown email", async () => {
    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        return { data: { results: [], total: 0 }, status: 200 };
      }
      throw new Error(`Must not call HubSpot beyond the contact search: ${url}`);
    });

    const res = await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    expect(res.body.status).toBe("UNMATCHED_CONTACT");
    expect(callsTo((c) => c.url.includes("/attendance/"))).toHaveLength(0);
    expect(callsTo((c) => c.url.includes("email-create"))).toHaveLength(0);
    expect(hubspotClient.request).toHaveBeenCalledTimes(1);
  });

  test("never reaches the contact-creating attendance call for an ambiguous email", async () => {
    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        return { data: { results: [{ id: "1" }, { id: "2" }], total: 2 }, status: 200 };
      }
      throw new Error(`Must not call HubSpot beyond the contact search: ${url}`);
    });

    const res = await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    expect(res.body.status).toBe("AMBIGUOUS_CONTACT");
    expect(callsTo((c) => c.url.includes("email-create"))).toHaveLength(0);
    expect(hubspotClient.request).toHaveBeenCalledTimes(1);
  });

  // The integration has no contact-create path at all: the only HubSpot call
  // that could create one is email-create, and it is unreachable without a
  // prior match. Proven here across all three contact outcomes.
  test("touches the CRM only to search, never to write a contact", async () => {
    await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    const crmCalls = callsTo((c) => c.url.startsWith("/crm/"));
    expect(crmCalls).toHaveLength(1);
    expect(crmCalls[0].url).toBe("/crm/v3/objects/contacts/search");
  });

  // Production holds events created before the switch to bare course IDs.
  // Those must be reused, never duplicated.
  test("adopts a pre-migration teachable-course-* event instead of creating a duplicate", async () => {
    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        return { data: { results: [{ id: "551" }], total: 1 }, status: 200 };
      }
      if (url === "/marketing/v3/marketing-events/2968746/identifiers") {
        return { data: { total: 0, results: [] }, status: 200 };
      }
      if (url === "/marketing/v3/marketing-events/teachable-course-2968746/identifiers") {
        return { data: { total: 1, results: [{ objectId: "evt-legacy" }] }, status: 200 };
      }
      if (url === "/marketing/v3/marketing-events/evt-legacy") return { data: {}, status: 200 };
      if (isParticipationsLookup(url)) {
        return {
          data: attendedParticipation({
            externalEventId: "teachable-course-2968746",
            marketingEventId: "evt-legacy",
            contactId: "551",
            email: "test@email.com",
          }),
          status: 200,
        };
      }
      if (url.includes("/attendance/")) {
        return { data: { results: [{ vid: 551, email: "test@email.com" }] }, status: 200 };
      }
      throw new Error(`Unexpected HubSpot call in test: ${url}`);
    });

    const res = await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);

    expect(res.body.status).toBe("SUCCEEDED");
    expect(callsTo((c) => c.url === "/marketing/v3/marketing-events/events")).toHaveLength(0);
    expect(callsTo((c) => c.method === "PATCH")).toHaveLength(1);
    const [attendance] = callsTo((c) => c.url.includes("/attendance/"));
    expect(attendance.url).toBe(
      "/marketing/v3/marketing-events/attendance/teachable-course-2968746/attend/email-create",
    );
  });

  test("redelivery of the same enrollment does not repeat any HubSpot write", async () => {
    await request(app).post(webhookUrl()).send([SUPPLIED_PAYLOAD]);
    const callsAfterFirst = hubspotClient.request.mock.calls.length;

    // Same enrollment, a different webhook delivery id — must still be deduped.
    const redelivery = {
      ...SUPPLIED_PAYLOAD,
      hook_event_id: 879962999,
      object: { ...SUPPLIED_PAYLOAD.object },
    };
    const res = await request(app).post(webhookUrl()).send([redelivery]);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCEEDED");
    expect(hubspotClient.request.mock.calls).toHaveLength(callsAfterFirst);
  });
});
