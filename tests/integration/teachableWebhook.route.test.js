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
let logger;

const reload = () => {
  jest.resetModules();
  hubspotClient = require("../../src/services/hubspot.client");
  teachableClient = require("../../src/services/teachableCourses.client");
  idempotencyStore = require("../../src/services/idempotencyStore");
  logger = require("../../src/utils/logger");
  app = require("../../src/app");
};

/** Merged metadata of the first warn log whose message matches. */
const warnContext = (pattern) => {
  const call = logger.warn.mock.calls.find(([message]) => pattern.test(message));
  return call?.[1];
};

const mockCourseFound = () =>
  teachableClient.request.mockImplementation(async ({ url }) => {
    const [, id] = url.match(/\/courses\/(\d+)/) || [];
    return { data: { course: { id: Number(id), name: `Course ${id}` } }, status: 200 };
  });

const mockCourseNotFound = () =>
  teachableClient.request.mockResolvedValue({ data: null, status: 404 });

const mockContactFound = (contactId = "42") =>
  hubspotClient.request.mockImplementation(async ({ url }) => {
    if (url === "/crm/v3/objects/contacts/search") {
      return { data: { results: [{ id: contactId }], total: 1 }, status: 200 };
    }
    if (url.endsWith("/identifiers")) {
      return { data: { total: 0, results: [] }, status: 200 };
    }
    if (url === "/marketing/v3/marketing-events/events") {
      return { data: { objectId: "evt-1" }, status: 200 };
    }
    if (isParticipationsLookup(url)) {
      return { data: attendedParticipation({ contactId }), status: 200 };
    }
    if (url.includes("/attendance/")) {
      return { data: { results: [{ vid: 1, email: "a@b.com" }] }, status: 200 };
    }
    throw new Error(`Unexpected HubSpot call in test: ${url}`);
  });

describe("POST /webhooks/teachable/:secretToken", () => {
  beforeEach(() => {
    reload();
  });

  test("rejects an invalid auth token with 401 and tracks no record", async () => {
    const payload = buildEnrollmentCompletedPayload();
    const res = await request(app).post("/webhooks/teachable/wrong-token").send(payload);
    expect(res.status).toBe(401);
    expect(idempotencyStore.get(payload.object.id)).toBeUndefined();
    expect(hubspotClient.request).not.toHaveBeenCalled();
  });

  test("rejects an invalid/incomplete payload with 400 and creates no row", async () => {
    const res = await request(app).post(webhookUrl()).send({ type: "Enrollment.completed" });
    expect(res.status).toBe(400);
    expect(hubspotClient.request).not.toHaveBeenCalled();
  });

  test("rejects a payload with an invalid learner email with 400", async () => {
    const payload = buildEnrollmentCompletedPayload({ object: { user: { email: "not-an-email" } } });
    const res = await request(app).post(webhookUrl()).send(payload);
    expect(res.status).toBe(400);
  });

  test("records ATTENDED for a completion, upserting the owned Marketing Event first", async () => {
    mockCourseFound();
    mockContactFound("42");
    const payload = buildEnrollmentCompletedPayload();
    const res = await request(app).post(webhookUrl()).send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCEEDED");
    const record = idempotencyStore.get(payload.object.id);
    expect(record.status).toBe("SUCCEEDED");
    expect(record.hubspotContactId).toBe("42");
    expect(hubspotClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "/marketing/v3/marketing-events/events",
        // hs_external_event_id is the bare Teachable Course ID.
        data: expect.objectContaining({
          externalEventId: "101",
          eventName: "Course 101",
        }),
      }),
    );
    // No fabricated description/url/type is written to the Marketing Event.
    const createCall = hubspotClient.request.mock.calls
      .map(([cfg]) => cfg)
      .find((cfg) => cfg.url === "/marketing/v3/marketing-events/events");
    expect(Object.keys(createCall.data).sort()).toEqual([
      "eventName",
      "eventOrganizer",
      "externalAccountId",
      "externalEventId",
    ]);
    expect(hubspotClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/marketing/v3/marketing-events/attendance/101/attend/email-create",
      }),
    );
  });

  // object.course_id is the canonical course identifier on the enrollment
  // record; object.course is the embedded copy. If the two ever disagree,
  // course_id wins (and the mismatch is logged).
  test("derives the Marketing Event from object.course_id, not object.course.id", async () => {
    mockCourseFound();
    mockContactFound("42");
    const payload = buildEnrollmentCompletedPayload({
      object: { course_id: 2968746, course: { id: 999999, name: "Embedded Copy" } },
    });
    const res = await request(app).post(webhookUrl()).send(payload);

    expect(res.body.status).toBe("SUCCEEDED");
    expect(teachableClient.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/courses/2968746" }),
    );
    expect(hubspotClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/marketing/v3/marketing-events/events",
        data: expect.objectContaining({ externalEventId: "2968746" }),
      }),
    );
  });

  test("logs an unmatched contact for review without creating one", async () => {
    mockCourseFound();
    hubspotClient.request.mockResolvedValue({ data: { results: [], total: 0 }, status: 200 });
    const payload = buildEnrollmentCompletedPayload();
    const res = await request(app).post(webhookUrl()).send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("UNMATCHED_CONTACT");
    expect(hubspotClient.request).toHaveBeenCalledTimes(1); // search only, no upsert, no attendance call
  });

  test("logs an ambiguous contact match rather than guessing", async () => {
    mockCourseFound();
    hubspotClient.request.mockResolvedValue({
      data: { results: [{ id: "1" }, { id: "2" }], total: 2 },
      status: 200,
    });
    const payload = buildEnrollmentCompletedPayload();
    const res = await request(app).post(webhookUrl()).send(payload);

    expect(res.body.status).toBe("AMBIGUOUS_CONTACT");
  });

  test("logs a course-not-found outcome without calling HubSpot at all", async () => {
    mockCourseNotFound();
    const payload = buildEnrollmentCompletedPayload({
      object: { course_id: 9999, course: { id: 9999, name: "Unknown Course" } },
    });
    const res = await request(app).post(webhookUrl()).send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COURSE_NOT_FOUND");
    expect(hubspotClient.request).not.toHaveBeenCalled();
  });

  test("a retryable Teachable API failure returns 503 and FAILED_RETRYABLE", async () => {
    teachableClient.request.mockRejectedValue(
      Object.assign(new Error("Teachable API Error: rate limited"), {
        statusCode: 429,
        errorCode: "RATE_LIMITED",
        retryable: true,
      }),
    );
    const payload = buildEnrollmentCompletedPayload();
    const res = await request(app).post(webhookUrl()).send(payload);

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("FAILED_RETRYABLE");
  });

  test("a retryable HubSpot failure returns 503 and FAILED_RETRYABLE", async () => {
    mockCourseFound();
    const err = Object.assign(new Error("HubSpot Error: rate limited"), {
      statusCode: 429,
      errorCode: "RATE_LIMITED",
      retryable: true,
    });
    hubspotClient.request.mockRejectedValue(err);
    const payload = buildEnrollmentCompletedPayload();
    const res = await request(app).post(webhookUrl()).send(payload);

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("FAILED_RETRYABLE");
  });

  test("a non-retryable HubSpot failure returns 200 and FAILED_PERMANENT (never trips Teachable's global auto-disable)", async () => {
    mockCourseFound();
    const err = Object.assign(new Error("HubSpot Error: bad request"), {
      statusCode: 400,
      errorCode: "HUBSPOT_BAD_REQUEST",
      retryable: false,
    });
    hubspotClient.request.mockRejectedValue(err);
    const payload = buildEnrollmentCompletedPayload();
    const res = await request(app).post(webhookUrl()).send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("FAILED_PERMANENT");
  });

  test("a HubSpot auth failure (401/403) is treated as retryable and returns 503", async () => {
    mockCourseFound();
    const err = Object.assign(new Error("HubSpot Error: unauthorized"), {
      statusCode: 401,
      errorCode: "HUBSPOT_AUTH_FAILURE",
      retryable: true,
    });
    hubspotClient.request.mockRejectedValue(err);
    const payload = buildEnrollmentCompletedPayload();
    const res = await request(app).post(webhookUrl()).send(payload);

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("FAILED_RETRYABLE");
  });

  test("a network/timeout failure is treated as retryable and returns 503", async () => {
    mockCourseFound();
    const err = Object.assign(new Error("HubSpot Connection Error: timeout"), {
      statusCode: 503,
      errorCode: "TIMEOUT",
      retryable: true,
    });
    hubspotClient.request.mockRejectedValue(err);
    const payload = buildEnrollmentCompletedPayload();
    const res = await request(app).post(webhookUrl()).send(payload);

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("FAILED_RETRYABLE");
  });

  // SOW §5.3: the unmatched learner must be logged FOR REVIEW. A review needs
  // to identify the learner and the course, and the operator then needs the
  // resend to actually reprocess the enrollment once they fix the blocker.
  describe("review outcomes: identifiable, and reprocessable on resend", () => {
    beforeEach(() => {
      jest.spyOn(logger, "warn").mockImplementation(() => {});
      mockCourseFound();
    });

    test("an unmatched contact is logged with the learner email and course", async () => {
      hubspotClient.request.mockResolvedValue({ data: { results: [], total: 0 }, status: 200 });
      const payload = buildEnrollmentCompletedPayload();

      const res = await request(app).post(webhookUrl()).send(payload);

      expect(res.body.status).toBe("UNMATCHED_CONTACT");
      expect(warnContext(/No HubSpot contact found/)).toMatchObject({
        enrollmentId: payload.object.id,
        learnerEmail: "student@example.com",
        courseId: 101,
        courseName: "First Aid Training",
        hookEventId: payload.hook_event_id,
      });
      // Same data is retained on the record, not only in the log stream.
      expect(idempotencyStore.get(payload.object.id).reviewContext).toMatchObject({
        learnerEmail: "student@example.com",
        courseId: 101,
      });
    });

    test("an ambiguous match retains the candidate contact ids, not just the count", async () => {
      hubspotClient.request.mockResolvedValue({
        data: { results: [{ id: "1" }, { id: "2" }], total: 2 },
        status: 200,
      });
      const payload = buildEnrollmentCompletedPayload();

      const res = await request(app).post(webhookUrl()).send(payload);

      expect(res.body.status).toBe("AMBIGUOUS_CONTACT");
      expect(warnContext(/Multiple HubSpot contacts/)).toMatchObject({
        learnerEmail: "student@example.com",
        candidateContactIds: ["1", "2"],
        candidateCount: 2,
      });
    });

    test("a course-not-found outcome is logged with the learner and course details", async () => {
      mockCourseNotFound();
      const payload = buildEnrollmentCompletedPayload({
        object: { course_id: 9999, course: { id: 9999, name: "Deleted Course" } },
      });

      const res = await request(app).post(webhookUrl()).send(payload);

      expect(res.body.status).toBe("COURSE_NOT_FOUND");
      expect(warnContext(/course not found/i)).toMatchObject({
        learnerEmail: "student@example.com",
        courseId: 9999,
        courseName: "Deleted Course",
      });
    });

    // The documented remediation: create/merge the contact in HubSpot, then
    // resend the event from Teachable's event history.
    test("resending after the contact is created reprocesses it to SUCCEEDED", async () => {
      hubspotClient.request.mockResolvedValue({ data: { results: [], total: 0 }, status: 200 });
      const payload = buildEnrollmentCompletedPayload();

      const first = await request(app).post(webhookUrl()).send(payload);
      expect(first.body.status).toBe("UNMATCHED_CONTACT");

      // The client creates the missing contact, then resends the same event.
      mockContactFound("42");
      const second = await request(app).post(webhookUrl()).send(payload);

      expect(second.status).toBe(200);
      expect(second.body.status).toBe("SUCCEEDED");
      const record = idempotencyStore.get(payload.object.id);
      expect(record.hubspotContactId).toBe("42");
      expect(record.reviewContext).toBeUndefined();
      expect(
        hubspotClient.request.mock.calls.filter(([cfg]) => cfg.url.includes("/attendance/")),
      ).toHaveLength(1);
    });

    test("resending an ambiguous match after the duplicates are merged succeeds", async () => {
      hubspotClient.request.mockResolvedValue({
        data: { results: [{ id: "1" }, { id: "2" }], total: 2 },
        status: 200,
      });
      const payload = buildEnrollmentCompletedPayload();
      expect((await request(app).post(webhookUrl()).send(payload)).body.status).toBe(
        "AMBIGUOUS_CONTACT",
      );

      mockContactFound("1");
      expect((await request(app).post(webhookUrl()).send(payload)).body.status).toBe("SUCCEEDED");
    });

    test("resending a course-not-found after the course is restored succeeds", async () => {
      mockCourseNotFound();
      const payload = buildEnrollmentCompletedPayload();
      expect((await request(app).post(webhookUrl()).send(payload)).body.status).toBe(
        "COURSE_NOT_FOUND",
      );

      mockCourseFound();
      mockContactFound("42");
      expect((await request(app).post(webhookUrl()).send(payload)).body.status).toBe("SUCCEEDED");
    });

    // A SUCCEEDED enrollment must stay deduped — reprocessing is only opened up
    // for outcomes that wrote nothing to HubSpot.
    test("a resend of a SUCCEEDED enrollment is still a no-op", async () => {
      mockContactFound("42");
      const payload = buildEnrollmentCompletedPayload();
      await request(app).post(webhookUrl()).send(payload);
      const callsAfterFirst = hubspotClient.request.mock.calls.length;

      const res = await request(app).post(webhookUrl()).send(payload);

      expect(res.body.status).toBe("SUCCEEDED");
      expect(hubspotClient.request.mock.calls).toHaveLength(callsAfterFirst);
    });
  });

  // The first completion of a brand-new course: HubSpot has never seen this
  // externalEventId, and answering 404 to the identifiers lookup used to fail
  // the enrollment permanently while returning 200 to Teachable (so it was
  // never redelivered either).
  test("a 404 from the marketing-event identifiers lookup still records attendance", async () => {
    mockCourseFound();
    hubspotClient.request.mockImplementation(async ({ url }) => {
      if (url === "/crm/v3/objects/contacts/search") {
        return { data: { results: [{ id: "42" }], total: 1 }, status: 200 };
      }
      if (url.endsWith("/identifiers")) {
        throw Object.assign(new Error("HubSpot Error: not found"), {
          statusCode: 404,
          errorCode: "HUBSPOT_NOT_FOUND",
          retryable: false,
        });
      }
      if (url === "/marketing/v3/marketing-events/events") {
        return { data: { objectId: "evt-1" }, status: 200 };
      }
      if (isParticipationsLookup(url)) {
        return { data: attendedParticipation(), status: 200 };
      }
      if (url.includes("/attendance/")) {
        return { data: { results: [{ vid: 1, email: "a@b.com" }] }, status: 200 };
      }
      throw new Error(`Unexpected HubSpot call in test: ${url}`);
    });
    const payload = buildEnrollmentCompletedPayload();

    const res = await request(app).post(webhookUrl()).send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCEEDED");
    expect(
      hubspotClient.request.mock.calls.filter(
        ([cfg]) => cfg.url === "/marketing/v3/marketing-events/events",
      ),
    ).toHaveLength(1);
    expect(
      hubspotClient.request.mock.calls.filter(([cfg]) => cfg.url.includes("/attendance/")),
    ).toHaveLength(1);
  });
});
