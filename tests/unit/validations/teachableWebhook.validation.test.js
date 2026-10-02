const {
  envelopeSchema,
  enrollmentCompletedSchema,
  resolveCompletionTimestamp,
} = require("../../../src/modules/teachable-webhook/validations/teachableWebhook.validation");
const { buildEnrollmentCompletedPayload } = require("../../fixtures/enrollmentCompletedPayload");

const validateEnvelope = (body) => envelopeSchema.body.validate(body, { abortEarly: false });
const validateCompleted = (event) =>
  enrollmentCompletedSchema.validate(event, { abortEarly: false });

describe("envelopeSchema (loose, any event type, object or array)", () => {
  test("accepts a bare event object", () => {
    expect(validateEnvelope(buildEnrollmentCompletedPayload()).error).toBeUndefined();
  });

  test("accepts an array of event envelopes (the shape Teachable actually delivers)", () => {
    expect(validateEnvelope([buildEnrollmentCompletedPayload()]).error).toBeUndefined();
  });

  test("accepts other event types this integration does not handle", () => {
    const userCreated = {
      type: "User.created",
      id: 1,
      livemode: true,
      created: "2026-09-11T08:04:26+00:00",
      hook_event_id: 2,
      object: { id: 1, role: "student", email: "test@email.com", name: "test" },
    };
    expect(validateEnvelope([userCreated]).error).toBeUndefined();
  });

  test("rejects an empty array", () => {
    expect(validateEnvelope([]).error).toBeDefined();
  });

  test("rejects an envelope with no type or no object", () => {
    expect(validateEnvelope({ object: {} }).error).toBeDefined();
    expect(validateEnvelope({ type: "Enrollment.completed" }).error).toBeDefined();
  });
});

describe("enrollmentCompletedSchema (strict)", () => {
  test("accepts a valid Enrollment.completed payload", () => {
    expect(validateCompleted(buildEnrollmentCompletedPayload()).error).toBeUndefined();
  });

  test("rejects a wrong event type", () => {
    expect(
      validateCompleted(buildEnrollmentCompletedPayload({ type: "Enrollment.created" })).error,
    ).toBeDefined();
  });

  test("rejects a payload missing the top-level id", () => {
    const payload = buildEnrollmentCompletedPayload();
    delete payload.id;
    expect(validateCompleted(payload).error).toBeDefined();
  });

  test("rejects a payload missing the learner email", () => {
    const payload = buildEnrollmentCompletedPayload();
    delete payload.object.user.email;
    expect(validateCompleted(payload).error).toBeDefined();
  });

  test("rejects an invalid email format", () => {
    const payload = buildEnrollmentCompletedPayload({ object: { user: { email: "not-an-email" } } });
    expect(validateCompleted(payload).error).toBeDefined();
  });

  test("rejects a payload missing the course id", () => {
    const payload = buildEnrollmentCompletedPayload();
    delete payload.object.course.id;
    expect(validateCompleted(payload).error).toBeDefined();
  });

  test("tolerates unknown extra fields at every level (forward compatibility)", () => {
    const payload = buildEnrollmentCompletedPayload();
    payload.newTopLevelField = "future";
    payload.object.newField = "future";
    payload.object.user.newField = "future";
    payload.object.course.newField = "future";
    expect(validateCompleted(payload).error).toBeUndefined();
  });

  test("accepts the richer real-world shape (offset timestamps, float percent, extra nested objects)", () => {
    const payload = buildEnrollmentCompletedPayload({
      created: "2026-09-11T08:04:29+00:00",
      object: {
        percent_complete: 100.0,
        meta: { class: "enrollment", url: null },
        user: { role: "student", sign_in_count: 0, tags: [] },
        course: { url: "https://school.teachable.com/courses/1", author_bio: { id: 1 } },
      },
    });
    expect(validateCompleted(payload).error).toBeUndefined();
  });

  test("does not require object.updated_at (fallback logic handles absence)", () => {
    const payload = buildEnrollmentCompletedPayload();
    delete payload.object.updated_at;
    expect(validateCompleted(payload).error).toBeUndefined();
  });
});

describe("resolveCompletionTimestamp", () => {
  test("uses object.updated_at when present and parseable", () => {
    const payload = buildEnrollmentCompletedPayload({
      created: "2022-01-01T00:00:00Z",
      object: { updated_at: "2022-05-27T14:46:57Z" },
    });
    expect(resolveCompletionTimestamp(payload)).toBe("2022-05-27T14:46:57.000Z");
  });

  test("falls back to top-level created when updated_at is missing", () => {
    const payload = buildEnrollmentCompletedPayload({ created: "2022-01-01T00:00:00Z" });
    delete payload.object.updated_at;
    expect(resolveCompletionTimestamp(payload)).toBe("2022-01-01T00:00:00.000Z");
  });

  test("falls back to top-level created when updated_at is unparseable", () => {
    const payload = buildEnrollmentCompletedPayload({
      created: "2022-01-01T00:00:00Z",
      object: { updated_at: "not-a-date" },
    });
    expect(resolveCompletionTimestamp(payload)).toBe("2022-01-01T00:00:00.000Z");
  });

  test("returns null when neither timestamp is parseable", () => {
    const payload = buildEnrollmentCompletedPayload({
      created: "not-a-date",
      object: { updated_at: "also-not-a-date" },
    });
    expect(resolveCompletionTimestamp(payload)).toBeNull();
  });
});
