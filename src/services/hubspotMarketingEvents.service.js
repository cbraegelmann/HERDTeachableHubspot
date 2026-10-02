const hubspotClient = require("./hubspot.client");
const config = require("../config/env");
const logger = require("../utils/logger");
const ApiError = require("../utils/apiError");

const MARKETING_EVENTS_BASE = "/marketing/v3/marketing-events";
const service = "HubspotMarketingEventsService";

/**
 * Looks up the internal objectId HubSpot assigned to the event this
 * integration owns, addressed by our own externalEventId. Returns null when
 * no such event exists yet.
 *
 * "Does not exist yet" reaches us in two different shapes, and BOTH must mean
 * null rather than an error:
 *   - `200 {total: 0, results: []}`, and
 *   - `404`, which HubSpot returns for an externalEventId it has never seen.
 * The 404 is the important one: it is the response the very first completion of
 * every new course can get, and before it was handled here it was classified as
 * a generic non-retryable 4xx, which failed the enrollment permanently and
 * dropped a perfectly valid completion (returning 200 to Teachable, so it was
 * never redelivered either). Any other error is rethrown untouched, so genuine
 * auth/rate-limit/5xx failures keep their existing retry classification.
 *
 * NOTE: this lookup is eventually consistent — verified against a live portal
 * (2026-09-17), it still reported `total: 0` immediately after a successful
 * create. The create path below therefore cannot rely on it alone and also
 * handles the resulting conflict.
 */
const resolveOwnedEventObjectId = async (externalEventId, logCtx) => {
  let data;
  try {
    ({ data } = await hubspotClient.request({
      method: "GET",
      url: `${MARKETING_EVENTS_BASE}/${encodeURIComponent(externalEventId)}/identifiers`,
      params: { externalAccountId: config.hubspot.marketingEvents.externalAccountId },
    }));
  } catch (error) {
    if (error.errorCode !== "HUBSPOT_NOT_FOUND") throw error;
    logger.info("No marketing event exists under this external id yet (404)", {
      ...logCtx,
      lookedUpExternalEventId: externalEventId,
    });
    return null;
  }
  return data?.results?.[0]?.objectId || null;
};

/**
 * A create for an (app, portal, externalAccountId, externalEventId) tuple that
 * already exists comes back as 400 UNIQUE_VALUE_CONFLICT on hs_unique_id, with
 * the id of the event that already holds the value in errorTokens. Verified
 * against a live 400 body (2026-09-17). Returns null for any other error.
 */
const extractConflictingObjectId = (error) => {
  const body = error?.hubspotResponse;
  if (body?.errorType !== "UNIQUE_VALUE_CONFLICT") return null;
  return body?.errorTokens?.existingObjectId?.[0] || null;
};

const updateOwnedEvent = async (objectId, { eventName, externalEventId }) => {
  await hubspotClient.request({
    method: "PATCH",
    url: `${MARKETING_EVENTS_BASE}/${objectId}`,
    data: { eventName },
  });
  return { objectId, externalEventId };
};

/**
 * Idempotently creates/updates the Marketing Event owned by this integration
 * for a given Teachable course. Called on every completion (not just the
 * first) so a course rename picked up from the live Teachable API lookup is
 * reflected in HubSpot too.
 *
 * This deliberately does NOT use /marketing-events/events/upsert. Verified
 * against a live portal (2026-09-17): that batch endpoint accepts a correctly
 * shaped `inputs` payload, answers 200 with `{status: "COMPLETE", results: []}`
 * — and creates nothing at all. Silent data loss. The single-event create
 * endpoint returns the event (with objectId) at the top level and actually
 * persists it, so resolve-then-create-or-update is used instead.
 *
 * Only `eventName` (-> hs_event_name) and `externalEventId`
 * (-> hs_external_event_id) are written. hs_event_url, hs_event_description
 * and hs_event_type are intentionally not set: no requirement defines a value
 * for them, and inventing one would put fabricated content on a real HubSpot
 * record. hs_start_datetime/hs_end_datetime are likewise not set — a learner's
 * completion is not the course event's start or end — and hs_event_status /
 * hs_event_status_v2 are HubSpot-calculated and never written.
 *
 * `legacyExternalEventId` supports the migration from prefixed external IDs
 * (`teachable-course-<id>`) to bare Teachable course IDs. A course whose event
 * is not found under the current ID is looked up under the legacy one before
 * anything is created; if it exists there, that event is adopted and keeps its
 * original external ID. Nothing is ever deleted, recreated or duplicated.
 *
 * Returns the objectId together with the external ID the event actually lives
 * under, which the caller must use to address attendance.
 */
const upsertOwnedEvent = async ({ externalEventId, legacyExternalEventId, eventName }, requestId) => {
  const action = "upsertOwnedEvent";
  const logCtx = { service, action, requestId, externalEventId };

  const existingObjectId = await resolveOwnedEventObjectId(externalEventId, logCtx);
  if (existingObjectId) {
    logger.info("Marketing event already exists; updating", {
      ...logCtx,
      objectId: existingObjectId,
    });
    return updateOwnedEvent(existingObjectId, { eventName, externalEventId });
  }

  if (legacyExternalEventId && legacyExternalEventId !== externalEventId) {
    const legacyObjectId = await resolveOwnedEventObjectId(legacyExternalEventId, logCtx);
    if (legacyObjectId) {
      logger.info("Adopting the pre-migration marketing event for this course", {
        ...logCtx,
        legacyExternalEventId,
        objectId: legacyObjectId,
      });
      return updateOwnedEvent(legacyObjectId, {
        eventName,
        externalEventId: legacyExternalEventId,
      });
    }
  }

  try {
    const { data } = await hubspotClient.request({
      method: "POST",
      url: `${MARKETING_EVENTS_BASE}/events`,
      data: {
        externalEventId,
        externalAccountId: config.hubspot.marketingEvents.externalAccountId,
        eventName,
        eventOrganizer: config.hubspot.marketingEvents.organizer,
      },
    });

    const objectId = data?.objectId;
    if (!objectId) {
      logger.error("Marketing event create response missing objectId", {
        ...logCtx,
        rawResponse: data,
      });
      throw new ApiError(
        502,
        "HubSpot returned an unexpected marketing event create response shape",
        true,
        "",
        { errorCode: "INVALID_HUBSPOT_RESPONSE", retryable: false },
      );
    }

    logger.info("Marketing event created", { ...logCtx, objectId });
    return { objectId, externalEventId };
  } catch (error) {
    // Lost the race against the eventually-consistent lookup above (or a
    // concurrent completion for the same course). HubSpot told us which event
    // won; update that one rather than failing the enrollment.
    const conflictingObjectId = extractConflictingObjectId(error);
    if (!conflictingObjectId) throw error;

    logger.info("Marketing event create conflicted; updating the existing event", {
      ...logCtx,
      objectId: conflictingObjectId,
    });
    return updateOwnedEvent(conflictingObjectId, { eventName, externalEventId });
  }
};

// Confirmed against a live HubSpot 400 response body (2026-09-16): valid
// states for this endpoint are 'register', 'attend', or 'cancel' — not the
// uppercase 'ATTENDED' implied by the SOW/HubSpot's own marketing docs.
const ATTENDANCE_STATE = "attend";

/**
 * Body shape for /attendance/{state}/email-create. Every variant below was run
 * against a live portal (2026-09-17) and the resulting participation record was
 * read back, because this endpoint answers 200 whether or not it stored
 * anything:
 *
 *   {email, joinedAt: <ISO>}                                -> results: [] (DROPPED)
 *   {inputs:[{email, interactionDateTime, properties:{}}]}  -> results: [] (DROPPED)
 *   {inputs:[{email, interactionDateTime}]}                 -> results: [] (DROPPED)
 *   ^ same via the /{objectId}/attendance/... path          -> results: [] (DROPPED)
 *   {inputs:[{email, properties:{joinedAt, leftAt}}]}       -> 400, interactionDateTime required
 *   {inputs:[{email, interactionDateTime,
 *             properties:{joinedAt, leftAt}}]}              -> results: [{vid, email}] -> ATTENDED
 *
 * So `attend` requires BOTH interactionDateTime AND a populated
 * properties.joinedAt/leftAt. Omitting the properties (or sending them empty)
 * is accepted with 200 and silently discarded — the integration did this and
 * recorded no attendance at all.
 *
 * interactionDateTime must be epoch MILLISECONDS; seconds are dropped the same
 * silent way.
 *
 * joinedAt/leftAt are ISO8601 and must span a STRICTLY POSITIVE duration:
 * sending the same instant for both is rejected with
 * AttendanceValidationError.JOINED_AT_IS_LATER_THAN_LEFT_AT_FOR_EMAIL
 * ("joinedAt param must be earlier than leftAt").
 *
 * THE SPAN MUST BE AT LEAST ONE FULL SECOND. HubSpot stores the span as
 * `attendanceDurationSeconds` — an integer number of SECONDS — and silently
 * discards an input whose span rounds down to 0. A sub-second span is accepted
 * with `200 {status: "COMPLETE", results: [{vid, email}]}` and stores nothing
 * at all: no error, no empty results array, nothing to detect it by.
 *
 * Measured against a live portal (2026-09-17), same event, same contact, same
 * endpoint, varying only the span:
 *     1ms  -> 200, results: [{vid, email}] -> NOTHING PERSISTED
 *     60s  -> 200, results: [{vid, email}] -> ATTENDED, attendanceDurationSeconds 60
 *     1h   -> 200, results: [{vid, email}] -> ATTENDED, attendanceDurationSeconds 3600
 *
 * This previously read 1ms, described as "the shortest span the API accepts" —
 * inferred from the 400 returned when joinedAt equals leftAt. The API accepts
 * 1ms; it just throws it away. Every completion recorded zero attendance while
 * logging success. One second is the smallest span that actually persists, and
 * it keeps the original intent of not inventing a study duration: a course
 * completion is a point in time, not a session.
 */
const ATTENDANCE_MIN_DURATION_MS = 1000;

const buildAttendanceBody = (email, joinedAtIso) => {
  const joinedAtMs = new Date(joinedAtIso).getTime();
  return {
    inputs: [
      {
        email,
        interactionDateTime: joinedAtMs,
        properties: {
          joinedAt: new Date(joinedAtMs).toISOString(),
          leftAt: new Date(joinedAtMs + ATTENDANCE_MIN_DURATION_MS).toISOString(),
        },
      },
    ],
  };
};

/**
 * An empty `results` array means HubSpot stored nothing for this input. That
 * happens in two cases which the response does not distinguish:
 *   - the contact is already recorded in this state (a benign no-op on
 *     re-delivery — a fresh email returns [{vid, email}], the identical call
 *     repeated returns []), or
 *   - the input was silently discarded, which is what an `attend` call missing
 *     properties.joinedAt/leftAt does (see buildAttendanceBody).
 *
 * It cannot be failed on without breaking legitimate re-delivery, so it is
 * logged at warn instead. Treat a *sustained* stream of this warning as a real
 * failure, not noise: before 2026-09-17 it fired on every single completion
 * and no attendance was ever recorded. If it appears for first-time
 * completions, check buildAttendanceBody against the live endpoint again
 * rather than assuming the contact was already an attendee.
 *
 * The inverse does NOT hold either: a POPULATED results array is not proof the
 * participation was stored. A sub-second joinedAt/leftAt span returns
 * `results: [{vid, email}]` and persists nothing. Nothing in this response
 * distinguishes the two — that is why verifyAttendanceRecorded() reads the
 * participation back afterwards, and why these checks are a pre-filter rather
 * than the actual success criterion.
 */
const validateAttendanceResponse = (status, data, requestId, context) => {
  if (status < 200 || status >= 300) {
    logger.error("Unexpected HubSpot attendance response status", {
      service,
      action: "recordAttendance",
      requestId,
      status,
      rawResponse: data,
      ...context,
    });
    throw new ApiError(502, "HubSpot returned an unexpected attendance response", true, "", {
      errorCode: "INVALID_HUBSPOT_RESPONSE",
      retryable: false,
    });
  }

  // A 200 can still carry per-input validation errors (e.g. joinedAt not
  // earlier than leftAt). They mean the attendance was NOT recorded, so they
  // are a hard failure rather than a warning — silently treating one as
  // success is exactly how this went unnoticed in production.
  if (data?.errors?.length > 0) {
    logger.error("HubSpot rejected the attendance input", {
      service,
      action: "recordAttendance",
      requestId,
      hubspotErrors: data.errors,
      ...context,
    });
    throw new ApiError(502, "HubSpot rejected the attendance input", true, "", {
      errorCode: "INVALID_HUBSPOT_RESPONSE",
      retryable: false,
    });
  }

  if (!(data?.results?.length > 0)) {
    logger.warn("Attendance call recorded no new attendee (already attending, or input ignored)", {
      service,
      action: "recordAttendance",
      requestId,
      rawResponse: data,
      ...context,
    });
  }
};

/**
 * Reads the participation back and confirms HubSpot actually stored it.
 *
 * This exists because the attendance endpoint's response cannot be trusted: a
 * 200 carrying a populated `results` array is what a silently-discarded input
 * looks like too (see ATTENDANCE_MIN_DURATION_MS). Three separate silent-drop
 * variants have reached production through that gap. The participation record
 * is the only authoritative answer.
 *
 * Addressed by CONTACT, not by event. The event-scoped breakdown
 * (/participations/{objectId}/breakdown) reported `total: 0` for a
 * participation that demonstrably existed and was readable via the
 * contact-scoped one (verified live 2026-09-17) — it appears to be an
 * asynchronous rollup, like the event's own `attendees` counter, which also
 * still read 0 well after the participation was stored. Neither is usable as a
 * verification signal.
 *
 * Polled rather than read once, because the write is not instantly readable.
 */
const VERIFY_ATTEMPTS = 4;
const VERIFY_BACKOFF_MS = 1000;
const PARTICIPATION_PAGE_LIMIT = 100;
const MAX_PARTICIPATION_PAGES = 5;

const findAttendedParticipation = async ({ contactId, objectId, externalEventId }) => {
  let after;
  for (let page = 0; page < MAX_PARTICIPATION_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await hubspotClient.request({
      method: "GET",
      url: `${MARKETING_EVENTS_BASE}/participations/contacts/${encodeURIComponent(contactId)}/breakdown`,
      params: { limit: PARTICIPATION_PAGE_LIMIT, ...(after ? { after } : {}) },
    });

    const match = (data?.results || []).find((participation) => {
      const event = participation?.associations?.marketingEvent || {};
      return (
        (objectId && String(event.marketingEventId) === String(objectId)) ||
        String(event.externalEventId) === String(externalEventId)
      );
    });
    if (match) return match;

    after = data?.paging?.next?.after;
    if (!after) return null;
  }
  return null;
};

const verifyAttendanceRecorded = async ({ contactId, objectId, externalEventId }, requestId) => {
  const logCtx = { service, action: "verifyAttendanceRecorded", requestId, externalEventId };

  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const participation = await findAttendedParticipation({ contactId, objectId, externalEventId });
    const state = participation?.properties?.attendanceState;

    if (state === "ATTENDED") {
      logger.info("Attendance verified against the stored participation", {
        ...logCtx,
        attempt,
        attendanceDurationSeconds: participation.properties.attendanceDurationSeconds,
      });
      return participation;
    }

    if (attempt < VERIFY_ATTEMPTS) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, VERIFY_BACKOFF_MS));
    } else {
      logger.error("HubSpot accepted the attendance but stored no ATTENDED participation", {
        ...logCtx,
        attempts: attempt,
        observedState: state || "NONE",
      });
      throw new ApiError(
        502,
        "HubSpot acknowledged the attendance but no ATTENDED participation exists",
        true,
        "",
        { errorCode: "ATTENDANCE_NOT_PERSISTED", retryable: false },
      );
    }
  }

  return null;
};

/**
 * Records ATTENDED participation for a contact on the Marketing Event
 * identified by externalEventId (the one this integration owns and upserts
 * via upsertOwnedEvent above), then verifies it was actually stored.
 */
const recordAttendance = async (
  { externalEventId, resolvedObjectId, contactId, email, joinedAtIso },
  requestId,
) => {
  const action = "recordAttendance";

  // externalAccountId must travel as a QUERY parameter here, not in the body.
  // Verified against a live 400 (2026-09-17): omitting it returns
  // "externalAccountId is required" even though the event is addressed by an
  // externalEventId this account owns.
  const { status, data } = await hubspotClient.request({
    method: "POST",
    url: `${MARKETING_EVENTS_BASE}/attendance/${externalEventId}/${ATTENDANCE_STATE}/email-create`,
    params: { externalAccountId: config.hubspot.marketingEvents.externalAccountId },
    data: buildAttendanceBody(email, joinedAtIso),
  });
  validateAttendanceResponse(status, data, requestId, { externalEventId });

  // The response above is necessary but NOT sufficient — see
  // verifyAttendanceRecorded. Skipped only when no contact id was resolved,
  // which the caller's contact lookup makes impossible on the happy path.
  if (contactId) {
    await verifyAttendanceRecorded({ contactId, objectId: resolvedObjectId, externalEventId }, requestId);
  } else {
    logger.warn("No contact id supplied; attendance could not be verified", {
      service,
      action,
      requestId,
      externalEventId,
    });
  }

  logger.info("Attendance recorded", { service, action, requestId, externalEventId });
  return { hubspotMarketingEventId: resolvedObjectId || externalEventId };
};

module.exports = { upsertOwnedEvent, recordAttendance };
