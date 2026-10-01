/**
 * Central error taxonomy. Each code carries a default `retryable` flag (does
 * retrying stand a chance of succeeding?) and a log level, so callers don't
 * have to re-derive retry/logging decisions ad hoc. Extend as integrations
 * are added.
 */
const ERROR_CODES = {
  INVALID_PAYLOAD: { retryable: false, logLevel: "warn" },
  AUTH_FAILURE: { retryable: false, logLevel: "warn" },
  INVALID_CONFIG: { retryable: false, logLevel: "error" },
  NOT_FOUND: { retryable: false, logLevel: "warn" },
  RATE_LIMITED: { retryable: true, logLevel: "warn" },
  NETWORK_ERROR: { retryable: true, logLevel: "error" },
  TIMEOUT: { retryable: true, logLevel: "error" },
  UNEXPECTED_ERROR: { retryable: false, logLevel: "error" },
};

const isRetryable = (errorCode) => ERROR_CODES[errorCode]?.retryable ?? false;
const logLevelFor = (errorCode) => ERROR_CODES[errorCode]?.logLevel ?? "error";

module.exports = { ERROR_CODES, isRetryable, logLevelFor };
