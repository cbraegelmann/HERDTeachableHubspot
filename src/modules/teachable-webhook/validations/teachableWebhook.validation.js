const Joi = require("joi");
const commonSchemas = require("../../../validations/common.schema");

const ENROLLMENT_COMPLETED_EVENT = "Enrollment.completed";

// Teachable webhook deliveries observed from a real school arrive as a JSON
// ARRAY of event envelopes (`[{ type, id, created, hook_event_id, object }]`),
// even though Teachable's documentation sample shows a bare object. Both
// shapes are accepted. This envelope check is deliberately loose: it only
// asserts the minimum needed to dispatch on `type`, because a webhook
// subscribed to more than one event type (or "All events") legitimately
// delivers payloads of other shapes (User.created, Sale.created,
// LectureProgress.created, ...) that must be acknowledged, not rejected —
// a 4xx response counts as a failure toward Teachable's four-consecutive-
// failure webhook auto-disable.
const eventEnvelopeSchema = Joi.object({
  type: Joi.string().required(),
  object: Joi.object().unknown(true).required(),
}).unknown(true);

const envelopeSchema = {
  body: Joi.alternatives()
    .try(eventEnvelopeSchema, Joi.array().items(eventEnvelopeSchema).min(1))
    .required(),
};

// Strict shape for the one event this integration acts on. .unknown(true)
// throughout: Teachable adding new fields later must not break ingestion of
// an otherwise-valid completion event.
const enrollmentCompletedSchema = Joi.object({
  type: Joi.string().valid(ENROLLMENT_COMPLETED_EVENT).required(),
  id: Joi.number().integer().required(),
  livemode: Joi.boolean().optional(),
  created: Joi.string().isoDate().required(),
  hook_event_id: Joi.number().integer().required(),
  object: Joi.object({
    id: Joi.number().integer().required(),
    course_id: Joi.number().integer().required(),
    // Optional: it keys the course-progress lookup that resolves the real
    // completion timestamp, but a payload without it must still be processed
    // (the timestamp then falls back to the derivation below).
    user_id: Joi.number().integer().optional(),
    updated_at: Joi.string().isoDate().optional(),
    user: Joi.object({
      id: Joi.number().integer().optional(),
      email: commonSchemas.email,
      name: Joi.string().allow("", null).optional(),
    })
      .unknown(true)
      .required(),
    course: Joi.object({
      id: Joi.number().integer().required(),
      name: Joi.string().allow("", null).required(),
    })
      .unknown(true)
      .required(),
  })
    .unknown(true)
    .required(),
}).unknown(true);

/**
 * Fallback completion timestamp, used only when Teachable's own `completed_at`
 * is unavailable (see teachableCourses.service.js#getCourseProgress). The
 * Enrollment.completed payload has no dedicated "completed at" field, so this
 * derives one from object.updated_at, falling back to the webhook's top-level
 * `created` timestamp. Returns null if neither is a parseable date, which the
 * caller treats as an invalid payload.
 */
const resolveCompletionTimestamp = (body) => {
  const candidates = [body?.object?.updated_at, body?.created];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
};

module.exports = {
  ENROLLMENT_COMPLETED_EVENT,
  envelopeSchema,
  enrollmentCompletedSchema,
  resolveCompletionTimestamp,
};
