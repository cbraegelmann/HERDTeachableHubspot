const enrollmentProcessor = require("../services/enrollmentProcessor.service");
const {
  ENROLLMENT_COMPLETED_EVENT,
  enrollmentCompletedSchema,
} = require("../validations/teachableWebhook.validation");
const asyncHandler = require("../../../utils/asyncHandler");
const ApiError = require("../../../utils/apiError");
const logger = require("../../../utils/logger");

const IGNORED_EVENT_TYPE = "IGNORED_EVENT_TYPE";

/**
 * Handles a Teachable webhook delivery. Real deliveries arrive as an array of
 * event envelopes (Teachable's docs sample shows a bare object; both are
 * accepted). Each event is dispatched on its `type`:
 *  - Enrollment.completed -> strictly validated, then processed. A malformed
 *    completion event fails the whole request with 400, since that signals a
 *    real integration problem that retrying cannot fix.
 *  - anything else -> acknowledged and ignored (200). Rejecting these would
 *    count as failures toward Teachable's four-consecutive-failure webhook
 *    auto-disable whenever the webhook is subscribed to more than this one
 *    event type.
 *
 * The response is 503 if any completion failed retryably (so Teachable
 * redelivers), otherwise 200. For a single-event delivery the top-level
 * `status`/`enrollmentId` mirror the one result for convenience.
 */
exports.handleWebhook = asyncHandler(async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  const results = [];
  let httpStatus = 200;

  for (const event of events) {
    if (event.type !== ENROLLMENT_COMPLETED_EVENT) {
      logger.info("Ignoring Teachable event type this integration does not handle", {
        requestId: req.id,
        service: "TeachableWebhook",
        action: "IGNORE_EVENT",
        eventType: event.type,
      });
      results.push({ type: event.type, status: IGNORED_EVENT_TYPE });
      continue;
    }

    const { error, value } = enrollmentCompletedSchema.validate(event, {
      abortEarly: false,
      errors: { label: "key" },
    });
    if (error) {
      throw new ApiError(400, error.details.map((d) => d.message).join(", "));
    }

    // eslint-disable-next-line no-await-in-loop
    const result = await enrollmentProcessor.processEnrollment(value, req.id);
    results.push({
      type: event.type,
      status: result.status,
      enrollmentId: result.enrollmentId,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
    if (result.httpStatus === 503) httpStatus = 503;
  }

  const body = { success: httpStatus < 300, results };
  if (results.length === 1) {
    body.status = results[0].status;
    if (results[0].enrollmentId !== undefined) body.enrollmentId = results[0].enrollmentId;
  }

  res.status(httpStatus).json(body);
});
