const idempotencyStore = require("../../../services/idempotencyStore");
const hubspotContacts = require("../../../services/hubspotContacts.service");
const hubspotMarketingEvents = require("../../../services/hubspotMarketingEvents.service");
const teachableCourses = require("../../../services/teachableCourses.service");
const config = require("../../../config/env");
const logger = require("../../../utils/logger");
const ApiError = require("../../../utils/apiError");
const { resolveCompletionTimestamp } = require("../validations/teachableWebhook.validation");

const extractEnrollmentData = (body) => {
  const completedAt = resolveCompletionTimestamp(body);
  if (!completedAt) {
    throw new ApiError(
      400,
      "Unable to resolve a completion timestamp from the webhook payload",
      true,
      "",
      { errorCode: "INVALID_PAYLOAD", retryable: false },
    );
  }

  const { object } = body;

  if (object.course_id !== object.course.id) {
    logger.warn("Teachable payload course_id/course.id mismatch", {
      service: "EnrollmentProcessor",
      action: "extractEnrollmentData",
      courseId: object.course_id,
      courseObjectId: object.course.id,
    });
  }

  return {
    enrollmentId: object.id,
    hookEventId: body.hook_event_id,
    learnerEmail: object.user.email.trim().toLowerCase(),
    // object.course_id is the canonical course identifier on the enrollment
    // record (object.course is the embedded copy). They agree in every real
    // payload observed; the warning above fires if they ever diverge.
    courseId: object.course_id,
    courseName: object.course.name,
    // object.user_id is the enrollment's own learner reference. object.user.id
    // is not used as a substitute: the two are not guaranteed to be the same
    // value, and querying progress for the wrong learner would yield a wrong
    // completion timestamp — worse than falling back to the derived one.
    learnerUserId: object.user_id,
    fallbackCompletedAt: completedAt,
  };
};

/**
 * Resolves the timestamp recorded against the Marketing Event participation.
 *
 * Teachable's Enrollment.completed payload carries no completion timestamp, but
 * its REST API does expose one: GET /v1/courses/{id}/progress returns a
 * top-level, nullable `completed_at`. That value is authoritative and is used
 * whenever it is available.
 *
 * Every failure to obtain it is non-fatal and falls back to the payload-derived
 * timestamp (object.updated_at -> webhook `created`). Failing an enrollment
 * outright over a timestamp refinement would trade a correct participation
 * record for no record at all, and would spend retry budget against Teachable's
 * four-consecutive-failure webhook auto-disable. Each fallback is logged at warn
 * so a systematic loss of the authoritative value is visible.
 */
const TIMESTAMP_SOURCE_AUTHORITATIVE = "course_progress.completed_at";
const TIMESTAMP_SOURCE_FALLBACK = "webhook_fallback";

const resolveParticipationTimestamp = async (enrollment, logCtx) => {
  const fallback = {
    completedAt: enrollment.fallbackCompletedAt,
    source: TIMESTAMP_SOURCE_FALLBACK,
  };

  // An earlier attempt at this same enrollment already resolved a timestamp:
  // reuse it verbatim. The two sources below can legitimately disagree between
  // attempts (the live lookup may fail on one and succeed on the next), and
  // HubSpot's attendance write is only idempotent for an unchanged
  // (contact, interactionDateTime) pair — so re-resolving here is what would
  // turn a retry into a second, differently-timestamped participation record.
  const pinned = idempotencyStore.get(enrollment.enrollmentId)?.participation;
  if (pinned) {
    logger.info("Reusing the participation timestamp pinned by an earlier attempt", {
      ...logCtx,
      timestampSource: pinned.source,
    });
    return pinned;
  }

  if (!enrollment.learnerUserId) {
    logger.warn("Payload carries no user id; using the payload-derived completion timestamp", logCtx);
    return fallback;
  }

  let progress;
  try {
    progress = await teachableCourses.getCourseProgress(
      enrollment.courseId,
      enrollment.learnerUserId,
    );
  } catch (error) {
    logger.warn("Course progress lookup failed; using the payload-derived completion timestamp", {
      ...logCtx,
      errorCode: error.errorCode,
    });
    return fallback;
  }

  if (!progress?.completedAt) {
    logger.warn("Teachable reports no completed_at yet; using the payload-derived timestamp", {
      ...logCtx,
      percentComplete: progress?.percentComplete,
    });
    return fallback;
  }

  const parsed = new Date(progress.completedAt);
  if (Number.isNaN(parsed.getTime())) {
    logger.warn("Teachable returned an unparseable completed_at; using the payload-derived timestamp", {
      ...logCtx,
    });
    return fallback;
  }

  return { completedAt: parsed.toISOString(), source: TIMESTAMP_SOURCE_AUTHORITATIVE };
};

/**
 * Classifies a failed HubSpot/downstream call into a terminal idempotency-
 * store status and the HTTP status we return to Teachable. FAILED_RETRYABLE
 * + 503 lets Teachable's own webhook retry mechanism pick this back up
 * later. Everything else (non-retryable, or retryable but out of attempts)
 * returns 200 so that a run of unrelated failures can never trip Teachable's
 * global four-consecutive-failure auto-disable for the whole webhook.
 */
const finalizeFailure = (enrollmentId, error, logCtx) => {
  const errorCode = error.errorCode || "UNEXPECTED_ERROR";
  const retryable = error.retryable ?? false;
  const record = idempotencyStore.get(enrollmentId);
  const attemptsExhausted = (record?.attemptCount ?? 1) >= config.processing.maxAttempts;

  const status = retryable && !attemptsExhausted ? "FAILED_RETRYABLE" : "FAILED_PERMANENT";

  idempotencyStore.markFailed(enrollmentId, {
    status,
    errorCode,
    errorMessage: error.message,
  });

  const level = status === "FAILED_PERMANENT" ? "error" : "warn";
  logger[level]("Enrollment processing failed", {
    ...logCtx,
    errorCode,
    retryable,
    retryAfter: error.retryAfter,
    attemptsExhausted,
    status,
  });

  const httpStatus = status === "FAILED_RETRYABLE" ? 503 : 200;
  return { httpStatus, status, enrollmentId, errorCode };
};

const processEnrollment = async (body, requestId) => {
  const enrollment = extractEnrollmentData(body);
  const logCtx = {
    service: "EnrollmentProcessor",
    action: "processEnrollment",
    requestId,
    enrollmentId: enrollment.enrollmentId,
  };

  const claim = idempotencyStore.claim(enrollment.enrollmentId, {
    maxAttempts: config.processing.maxAttempts,
    staleProcessingTimeoutMs: config.processing.staleProcessingTimeoutMs,
  });

  if (!claim.claimed) {
    logger.info("Enrollment already processed or in-flight; skipping", {
      ...logCtx,
      existingStatus: claim.record?.status,
    });
    return { httpStatus: 200, status: claim.record?.status, enrollmentId: enrollment.enrollmentId };
  }

  logger.info("Enrollment claimed for processing", { ...logCtx, courseId: enrollment.courseId });

  let course;
  try {
    course = await teachableCourses.getCourseById(enrollment.courseId);
  } catch (error) {
    return finalizeFailure(enrollment.enrollmentId, error, logCtx);
  }

  if (!course) {
    const reviewContext = {
      learnerEmail: enrollment.learnerEmail,
      courseId: enrollment.courseId,
      courseName: enrollment.courseName,
      hookEventId: enrollment.hookEventId,
    };
    idempotencyStore.markOutcome(enrollment.enrollmentId, "COURSE_NOT_FOUND", reviewContext);
    logger.warn("Teachable course not found via live API lookup; logged for review", {
      ...logCtx,
      ...reviewContext,
    });
    return { httpStatus: 200, status: "COURSE_NOT_FOUND", enrollmentId: enrollment.enrollmentId };
  }

  let contactResult;
  try {
    contactResult = await hubspotContacts.findContactByEmail(enrollment.learnerEmail, requestId);
  } catch (error) {
    return finalizeFailure(enrollment.enrollmentId, error, logCtx);
  }

  // SOW §5.3 requires the unmatched learner to be LOGGED FOR REVIEW. A review
  // that cannot identify the learner or the course is not a review, so these
  // two outcomes deliberately carry the learner email and course details —
  // both into the log line and onto the idempotency record. This is the one
  // place learner PII is logged on purpose; it is the data the client needs to
  // create/merge the contact and resend the event from Teachable.
  if (contactResult.outcome === "NOT_FOUND") {
    const reviewContext = {
      learnerEmail: enrollment.learnerEmail,
      courseId: enrollment.courseId,
      courseName: enrollment.courseName,
      hookEventId: enrollment.hookEventId,
    };
    idempotencyStore.markOutcome(enrollment.enrollmentId, "UNMATCHED_CONTACT", reviewContext);
    logger.warn("No HubSpot contact found for learner email; logged for review", {
      ...logCtx,
      ...reviewContext,
    });
    return { httpStatus: 200, status: "UNMATCHED_CONTACT", enrollmentId: enrollment.enrollmentId };
  }

  if (contactResult.outcome === "AMBIGUOUS") {
    const reviewContext = {
      learnerEmail: enrollment.learnerEmail,
      courseId: enrollment.courseId,
      courseName: enrollment.courseName,
      hookEventId: enrollment.hookEventId,
      // The ids themselves, not just how many: resolving the duplicate means
      // opening these exact contacts in HubSpot.
      candidateContactIds: contactResult.candidateIds,
      candidateCount: contactResult.candidateIds.length,
    };
    idempotencyStore.markOutcome(enrollment.enrollmentId, "AMBIGUOUS_CONTACT", reviewContext);
    logger.warn("Multiple HubSpot contacts matched learner email; logged for review", {
      ...logCtx,
      ...reviewContext,
    });
    return { httpStatus: 200, status: "AMBIGUOUS_CONTACT", enrollmentId: enrollment.enrollmentId };
  }

  const participation = await resolveParticipationTimestamp(enrollment, logCtx);
  const { completedAt, source: timestampSource } = participation;
  // Pinned before the write, so every later attempt at this enrollment sends
  // the identical attendance body rather than re-resolving a timestamp that
  // may have changed source in the meantime.
  idempotencyStore.pinParticipation(enrollment.enrollmentId, participation);

  try {
    const { externalIdPrefix, legacyExternalIdPrefix } = config.hubspot.marketingEvents;
    // Only the course name is written to the Marketing Event. hs_event_url /
    // hs_event_description / hs_event_type are deliberately left unset: no
    // requirement defines them, and the start/end/status properties are
    // HubSpot-calculated (see FLOW_SCENARIOS.md §2).
    const { objectId, externalEventId: resolvedExternalEventId } =
      await hubspotMarketingEvents.upsertOwnedEvent(
        {
          externalEventId: `${externalIdPrefix}${enrollment.courseId}`,
          legacyExternalEventId: legacyExternalIdPrefix
            ? `${legacyExternalIdPrefix}${enrollment.courseId}`
            : null,
          eventName: course.name || enrollment.courseName,
        },
        requestId,
      );

    // Addressed by whichever external id the event actually lives under, so an
    // adopted pre-migration event still receives its attendance.
    const attendance = await hubspotMarketingEvents.recordAttendance(
      {
        externalEventId: resolvedExternalEventId,
        resolvedObjectId: objectId,
        // Used only to read the participation back and confirm it was stored;
        // the write itself is still addressed by email. See
        // hubspotMarketingEvents.service.js#verifyAttendanceRecorded.
        contactId: contactResult.contactId,
        email: enrollment.learnerEmail,
        joinedAtIso: completedAt,
      },
      requestId,
    );

    idempotencyStore.markSucceeded(enrollment.enrollmentId, {
      hubspotContactId: contactResult.contactId,
      hubspotMarketingEventId: attendance.hubspotMarketingEventId,
    });

    logger.info("Attendance recorded successfully", {
      ...logCtx,
      contactId: contactResult.contactId,
      hubspotMarketingEventId: attendance.hubspotMarketingEventId,
      timestampSource,
    });

    return { httpStatus: 200, status: "SUCCEEDED", enrollmentId: enrollment.enrollmentId };
  } catch (error) {
    return finalizeFailure(enrollment.enrollmentId, error, logCtx);
  }
};

module.exports = { processEnrollment, extractEnrollmentData };
