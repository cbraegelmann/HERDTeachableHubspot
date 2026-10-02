/**
 * Central error taxonomy for the integration. Each code carries a default
 * `retryable` flag (does retrying stand a chance of succeeding?) and a log
 * level, so callers don't have to re-derive retry/logging decisions ad hoc.
 */
const ERROR_CODES = {
  INVALID_PAYLOAD: { retryable: false, logLevel: "warn" },
  AUTH_FAILURE: { retryable: false, logLevel: "warn" },
  INVALID_CONFIG: { retryable: false, logLevel: "error" },
  INVALID_HUBSPOT_RESPONSE: { retryable: false, logLevel: "error" },
  HUBSPOT_BAD_REQUEST: { retryable: false, logLevel: "error" },
  // Distinct from HUBSPOT_BAD_REQUEST (same non-retryable semantics) so that a
  // caller which has a legitimate "this record does not exist yet" meaning for
  // 404 can recognise it without string-matching on a status code. See
  // hubspotMarketingEvents.service.js#resolveOwnedEventObjectId.
  HUBSPOT_NOT_FOUND: { retryable: false, logLevel: "warn" },
  // HubSpot acknowledged an attendance write (2xx, populated `results`) but the
  // participation does not exist when read back. Non-retryable because the same
  // request would be discarded the same way: this means the REQUEST is wrong,
  // not that HubSpot is unwell. Alert on it — it is the signal that a silent
  // drop is happening. See hubspotMarketingEvents.service.js#verifyAttendanceRecorded.
  ATTENDANCE_NOT_PERSISTED: { retryable: false, logLevel: "error" },
  HUBSPOT_AUTH_FAILURE: { retryable: true, logLevel: "error" },
  HUBSPOT_API_FAILURE: { retryable: true, logLevel: "error" },
  TEACHABLE_BAD_REQUEST: { retryable: false, logLevel: "error" },
  TEACHABLE_AUTH_FAILURE: { retryable: true, logLevel: "error" },
  TEACHABLE_API_FAILURE: { retryable: true, logLevel: "error" },
  RATE_LIMITED: { retryable: true, logLevel: "warn" },
  NETWORK_ERROR: { retryable: true, logLevel: "error" },
  TIMEOUT: { retryable: true, logLevel: "error" },
  UNEXPECTED_ERROR: { retryable: false, logLevel: "error" },
};

const isRetryable = (errorCode) => ERROR_CODES[errorCode]?.retryable ?? false;
const logLevelFor = (errorCode) => ERROR_CODES[errorCode]?.logLevel ?? "error";

module.exports = { ERROR_CODES, isRetryable, logLevelFor };
