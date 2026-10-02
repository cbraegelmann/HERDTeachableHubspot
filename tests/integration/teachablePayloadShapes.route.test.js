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

const reload = () => {
  jest.resetModules();
  hubspotClient = require("../../src/services/hubspot.client");
  teachableClient = require("../../src/services/teachableCourses.client");
  app = require("../../src/app");
};

const mockCourseFound = () =>
  teachableClient.request.mockImplementation(async ({ url }) => {
    const [, id] = url.match(/\/courses\/(\d+)/) || [];
    return { data: { course: { id: Number(id), name: `Course ${id}` } }, status: 200 };
  });

const mockContactFound = () =>
  hubspotClient.request.mockImplementation(async ({ url }) => {
    if (url === "/crm/v3/objects/contacts/search") {
      return { data: { results: [{ id: "42" }], total: 1 }, status: 200 };
    }
    if (url.endsWith("/identifiers")) {
      return { data: { total: 0, results: [] }, status: 200 };
    }
    if (url === "/marketing/v3/marketing-events/events") {
      return { data: { objectId: "evt-1" }, status: 200 };
    }
    if (isParticipationsLookup(url)) {
      return { data: attendedParticipation(), status: 200 };
    }
    return { data: { results: [{ vid: 1, email: "a@b.com" }] }, status: 200 };
  });

// Shapes taken from real deliveries observed from a Teachable school: every
// delivery is a JSON array of envelopes, and a webhook subscribed to more
// than one event type delivers payloads of unrelated shapes.
const userCreatedEvent = {
  type: "User.created",
  id: 130703604,
  livemode: true,
  created: "2026-09-11T08:04:26+00:00",
  hook_event_id: 879371407,
  object: { id: 130703604, role: "student", email: "test@email.com", name: "test", school_id: 1 },
};

const lectureProgressEvent = {
  type: "LectureProgress.created",
  id: 1750122118,
  livemode: true,
  created: "2026-09-11T14:50:16+00:00",
  hook_event_id: 879398686,
  object: {
    id: 1750122118,
    is_completed: true,
    course_id: 2966495,
    lecture_id: 65421249,
    percent_complete: 100,
    course: { id: 2966495, name: "Truck Guard Overview Training" },
    user: { id: 130706781, email: "learner@example.com", name: "Learner" },
    lecture: { id: 65421249, name: "Warranty", is_published: true },
  },
};

describe("Teachable payload shapes (array-wrapped deliveries, other event types)", () => {
  beforeEach(() => {
    reload();
  });

  test("processes an Enrollment.completed delivered as a single-element array", async () => {
    mockCourseFound();
    mockContactFound();
    const payload = buildEnrollmentCompletedPayload();

    const res = await request(app).post(webhookUrl()).send([payload]);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCEEDED");
    expect(res.body.enrollmentId).toBe(payload.object.id);
    expect(res.body.results).toEqual([
      { type: "Enrollment.completed", status: "SUCCEEDED", enrollmentId: payload.object.id },
    ]);
  });

  test("still processes an Enrollment.completed delivered as a bare object", async () => {
    mockCourseFound();
    mockContactFound();
    const res = await request(app).post(webhookUrl()).send(buildEnrollmentCompletedPayload());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCEEDED");
  });

  test.each([
    ["User.created", userCreatedEvent],
    ["LectureProgress.created", lectureProgressEvent],
  ])("acknowledges and ignores an unrelated %s event with 200, calling HubSpot zero times", async (_type, event) => {
    const res = await request(app).post(webhookUrl()).send([event]);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("IGNORED_EVENT_TYPE");
    expect(res.body.results[0].type).toBe(event.type);
    expect(hubspotClient.request).not.toHaveBeenCalled();
  });

  test("a mixed batch processes the completion and ignores the rest", async () => {
    mockCourseFound();
    mockContactFound();
    const completion = buildEnrollmentCompletedPayload();

    const res = await request(app)
      .post(webhookUrl())
      .send([userCreatedEvent, completion, lectureProgressEvent]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.results.map((r) => r.status)).toEqual([
      "IGNORED_EVENT_TYPE",
      "SUCCEEDED",
      "IGNORED_EVENT_TYPE",
    ]);
    // Multi-event responses don't carry a single top-level status.
    expect(res.body.status).toBeUndefined();
  });

  test("a retryable failure in a batch makes the whole delivery 503 so Teachable redelivers", async () => {
    mockCourseFound();
    hubspotClient.request.mockRejectedValue(
      Object.assign(new Error("rate limited"), {
        statusCode: 429,
        errorCode: "RATE_LIMITED",
        retryable: true,
      }),
    );

    const res = await request(app)
      .post(webhookUrl())
      .send([userCreatedEvent, buildEnrollmentCompletedPayload()]);

    expect(res.status).toBe(503);
    expect(res.body.results[1].status).toBe("FAILED_RETRYABLE");
  });

  test("a malformed Enrollment.completed inside an array is rejected with 400", async () => {
    const bad = buildEnrollmentCompletedPayload();
    delete bad.object.user.email;

    const res = await request(app).post(webhookUrl()).send([bad]);

    expect(res.status).toBe(400);
    expect(hubspotClient.request).not.toHaveBeenCalled();
  });

  test("an empty array is rejected with 400", async () => {
    const res = await request(app).post(webhookUrl()).send([]);
    expect(res.status).toBe(400);
  });
});
