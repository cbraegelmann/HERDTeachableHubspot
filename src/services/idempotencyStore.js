/**
 * In-memory idempotency guard for enrollment processing, keyed by the
 * Teachable Enrollment ID (the SOW's designated idempotency reference).
 *
 * No database is used. This is a deliberate choice, not a shortcut. What this
 * store needs to guarantee is cheap: suppressing redundant HubSpot calls for
 * concurrent requests and rapid webhook retries within a single process's
 * lifetime, which a synchronous, single-threaded Map does correctly with no
 * race window (there is no `await` between checking and claiming an entry).
 *
 * WHY A RESTART IS SAFE — and the one case it is not.
 * The downstream write this guards (HubSpot's Marketing Events attendance
 * endpoint) is idempotent for a given (contact, interactionDateTime) pair — see
 * hubspotMarketingEvents.service.js. So a replay only stays a harmless no-op
 * for as long as the SAME interactionDateTime is sent again.
 *
 * That value is NOT purely payload-derived any more. Since
 * resolveParticipationTimestamp() was introduced, it is whichever of two
 * sources answers at the time: Teachable's authoritative
 * `completed_at` (a live API call that can fail), or the payload-derived
 * fallback. Two attempts at the same enrollment can therefore legitimately
 * resolve two different timestamps.
 *
 * `pinParticipation()` closes that gap for every in-process attempt: the first
 * attempt to resolve a timestamp pins it on the record, and every reclaim of
 * that same enrollment reuses the pinned value instead of re-resolving. Retries
 * after a partial failure and redeliveries therefore always re-send an
 * identical attendance body, which HubSpot no-ops.
 *
 * The pin dies with the process. A replay AFTER a restart of an enrollment
 * whose attendance was already written may resolve a different timestamp, and
 * HubSpot's verified idempotency (per contact + interactionDateTime) does not
 * cover that case. It requires the enrollment to be redelivered after a restart
 * — Teachable does not redeliver a 200 on its own — so it is accepted, not
 * silently assumed away. See README "Idempotency (No Database)".
 *
 * Bounded to MAX_TRACKED_ENROLLMENTS to keep memory flat under sustained
 * traffic; oldest entries are evicted first (Map preserves insertion order).
 */

const MAX_TRACKED_ENROLLMENTS = 50000;

/**
 * Terminal outcomes that represent "processed correctly, but blocked by
 * something outside this integration" — no HubSpot write happened, and the
 * blocker (missing contact, duplicate contacts, deleted course) is fixed by a
 * human in HubSpot/Teachable rather than by retrying.
 *
 * They are reclaimable on redelivery, because resending the event from
 * Teachable's event history is the documented remediation once the blocker is
 * cleared (README "Idempotency"). Leaving them un-reclaimable made that
 * documented workflow a silent no-op.
 *
 * No attempt cap applies: these are only ever re-reached by a deliberate
 * redelivery (each one returns 200, so Teachable never redelivers them by
 * itself), and capping them would silently ignore an operator's 6th resend.
 * SUCCEEDED and FAILED_PERMANENT are deliberately NOT in this set — the former
 * needs no rework, the latter's no-op-on-redelivery behaviour is what stops a
 * retry loop that already exhausted its budget.
 */
const RECLAIMABLE_REVIEW_OUTCOMES = new Set([
  "UNMATCHED_CONTACT",
  "AMBIGUOUS_CONTACT",
  "COURSE_NOT_FOUND",
]);

const store = new Map();

const evictOldestIfNeeded = () => {
  if (store.size <= MAX_TRACKED_ENROLLMENTS) return;
  const oldestKey = store.keys().next().value;
  store.delete(oldestKey);
};

/**
 * Atomically claims an enrollment for processing. A fresh enrollment is
 * inserted directly as PROCESSING. A redelivery is reclaimed if the existing
 * record is a retryable failure with attempts remaining, a PROCESSING record
 * stuck long enough to be an abandoned/crashed attempt within this same
 * process, or a review outcome whose blocker a human may since have cleared
 * (see RECLAIMABLE_REVIEW_OUTCOMES). Everything else (SUCCEEDED,
 * FAILED_PERMANENT, or a genuinely in-flight PROCESSING record) is left
 * untouched and reported as not claimed.
 */
const claim = (enrollmentId, { maxAttempts, staleProcessingTimeoutMs }) => {
  const now = Date.now();
  const existing = store.get(enrollmentId);

  if (!existing) {
    const record = { status: "PROCESSING", attemptCount: 1, updatedAt: now };
    store.set(enrollmentId, record);
    evictOldestIfNeeded();
    return { claimed: true, record };
  }

  const isStaleProcessing =
    existing.status === "PROCESSING" && now - existing.updatedAt > staleProcessingTimeoutMs;
  const isReclaimableFailure =
    existing.status === "FAILED_RETRYABLE" && existing.attemptCount < maxAttempts;
  const isReclaimableReviewOutcome = RECLAIMABLE_REVIEW_OUTCOMES.has(existing.status);

  if (isStaleProcessing || isReclaimableFailure || isReclaimableReviewOutcome) {
    existing.status = "PROCESSING";
    // A review outcome consumed no part of the retry budget — nothing failed,
    // the enrollment was parked on an external blocker that has since been
    // fixed. Resetting keeps MAX_PROCESSING_ATTEMPTS meaning what it says
    // ("attempts before a *retryable failure* is marked permanent"); leaving it
    // to accumulate would let a handful of resends silently exhaust the budget
    // of the attempt that finally does real work.
    existing.attemptCount = isReclaimableReviewOutcome ? 1 : existing.attemptCount + 1;
    existing.updatedAt = now;
    return { claimed: true, record: existing };
  }

  return { claimed: false, record: existing };
};

const markSucceeded = (enrollmentId, { hubspotContactId, hubspotMarketingEventId }) => {
  const record = store.get(enrollmentId);
  if (!record) return;
  record.status = "SUCCEEDED";
  record.hubspotContactId = hubspotContactId;
  record.hubspotMarketingEventId = hubspotMarketingEventId;
  record.lastErrorCode = undefined;
  record.lastErrorMessage = undefined;
  // A reclaimed review outcome that now succeeds must not keep advertising the
  // blocker it was parked on.
  record.reviewContext = undefined;
  record.updatedAt = Date.now();
};

/**
 * For terminal, non-error outcomes: UNMATCHED_CONTACT, AMBIGUOUS_CONTACT,
 * COURSE_NOT_FOUND.
 *
 * `reviewContext` carries the identifying data needed to action the outcome
 * later (learner email, course id/name, candidate contact ids). It is kept on
 * the record — not just in the log line — so that an operator debugging a live
 * process can read back exactly why an enrollment was parked, and so the data
 * survives even if log shipping is misconfigured. Same bounded Map, no separate
 * store: the record for this enrollment already exists.
 */
const markOutcome = (enrollmentId, status, reviewContext) => {
  const record = store.get(enrollmentId);
  if (!record) return;
  record.status = status;
  if (reviewContext) record.reviewContext = reviewContext;
  record.updatedAt = Date.now();
};

/**
 * Pins the participation timestamp resolved for this enrollment so that every
 * later attempt re-sends an identical attendance body. See the module header
 * for why this is what keeps the HubSpot write idempotent now that the
 * timestamp comes from a live lookup that can fall back.
 */
const pinParticipation = (enrollmentId, participation) => {
  const record = store.get(enrollmentId);
  if (!record) return;
  record.participation = participation;
  record.updatedAt = Date.now();
};

const markFailed = (enrollmentId, { status, errorCode, errorMessage }) => {
  const record = store.get(enrollmentId);
  if (!record) return;
  record.status = status;
  record.lastErrorCode = errorCode;
  record.lastErrorMessage = errorMessage;
  record.updatedAt = Date.now();
};

const get = (enrollmentId) => store.get(enrollmentId);

/** Test-only: reset all tracked state between test cases. */
const _clear = () => store.clear();

module.exports = {
  claim,
  markSucceeded,
  markOutcome,
  markFailed,
  pinParticipation,
  get,
  _clear,
  RECLAIMABLE_REVIEW_OUTCOMES,
};
