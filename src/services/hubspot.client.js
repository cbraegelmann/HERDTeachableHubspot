const axios = require("axios");
const Bottleneck = require("bottleneck");
const Opossum = require("opossum");
const config = require("../config/env");
const logger = require("../utils/logger");
const ApiError = require("../utils/apiError");
const { isRetryable } = require("../utils/errorCodes");

let hubspotClientInstance = null;
let limiter = null;
let breaker = null;

const initializeHubSpotClient = () => {
  if (hubspotClientInstance) return hubspotClientInstance;

  if (!config.hubspot.accessToken || !config.hubspot.basePath) {
    logger.error("HubSpot configuration missing", {
      service: "HubSpotClient",
      action: "INITIALIZE",
      hasAccessToken: !!config.hubspot.accessToken,
      hasBasePath: !!config.hubspot.basePath,
    });
    throw new Error(
      "HubSpot configuration missing: accessToken and basePath are required",
    );
  }

  limiter = new Bottleneck({
    minTime: 200,
    maxConcurrent: 5,
  });

  hubspotClientInstance = axios.create({
    baseURL: config.hubspot.basePath,
    headers: {
      Authorization: `Bearer ${config.hubspot.accessToken}`,
      "Content-Type": "application/json",
    },
    timeout: 10000,
  });

  return hubspotClientInstance;
};

/**
 * Classifies a raw axios/network error into our error taxonomy: an errorCode
 * (see src/utils/errorCodes.js) plus a derived retryable flag. This is what
 * lets callers (the enrollment orchestrator) decide whether to let Teachable's
 * webhook retry pick this up, or mark it permanently failed for manual review,
 * without re-deriving HTTP-status semantics themselves.
 */
const classifyError = (error) => {
  if (!error.response) {
    const isTimeout =
      error.code === "ECONNABORTED" || /timeout/i.test(error.message || "");
    return {
      errorCode: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      statusCode: 503,
    };
  }

  const status = error.response.status;

  if (status === 429) {
    return { errorCode: "RATE_LIMITED", statusCode: 429 };
  }
  if (status === 401 || status === 403) {
    return { errorCode: "HUBSPOT_AUTH_FAILURE", statusCode: status };
  }
  // Classified separately from the generic 4xx below: for a lookup addressed by
  // an id we chose ourselves (a Marketing Event's externalEventId), a 404 means
  // "does not exist yet", which is a normal first-completion outcome rather
  // than a malformed request. Retry semantics are unchanged (non-retryable) —
  // only the code differs, so callers can tell the two apart.
  if (status === 404) {
    return { errorCode: "HUBSPOT_NOT_FOUND", statusCode: 404 };
  }
  if (status >= 500) {
    return { errorCode: "HUBSPOT_API_FAILURE", statusCode: status };
  }
  if (status >= 400) {
    return { errorCode: "HUBSPOT_BAD_REQUEST", statusCode: status };
  }

  return { errorCode: "UNEXPECTED_ERROR", statusCode: status || 500 };
};

const makeHubSpotRequest = async (requestConfig) => {
  try {
    const client = initializeHubSpotClient();
    const response = await client(requestConfig);
    return { data: response.data, status: response.status };
  } catch (error) {
    const { errorCode, statusCode } = classifyError(error);
    const retryable = isRetryable(errorCode);
    const retryAfter = error.response?.headers?.["retry-after"];

    logger.error("HubSpot API Error", {
      service: "HubSpotClient",
      action: "REQUEST",
      errorCode,
      retryable,
      statusCode,
      url: requestConfig.url,
      method: requestConfig.method,
      hubspotMessage: error.response?.data?.message,
      hubspotCorrelationId: error.response?.data?.correlationId,
    });

    const apiError = new ApiError(
      statusCode,
      `HubSpot Error: ${error.response?.data?.message || error.message}`,
      true,
      "",
      { errorCode, retryable },
    );
    apiError.retryAfter = retryAfter;
    // Preserve HubSpot's raw error body. Some recoverable conditions are only
    // distinguishable from its structured fields — e.g. a marketing-event
    // create that collides with an existing event returns errorType
    // UNIQUE_VALUE_CONFLICT plus the winning object's id in errorTokens,
    // which the caller needs in order to fall back to an update.
    apiError.hubspotResponse = error.response?.data;
    throw apiError;
  }
};

const initializeCircuitBreaker = () => {
  if (breaker) return breaker;

  const breakerOptions = {
    timeout: 10000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    rollingCountTimeout: 60000,
    // A 400/404/409 means WE sent a bad request (or asked for something that
    // does not exist), not that HubSpot is unhealthy. Excluding those here
    // keeps the breaker's error accounting focused on genuine
    // downstream-unavailability signals (timeouts, 429, 5xx, network errors),
    // so a burst of unrelated bad requests — or the 404 every brand-new
    // course's first identifiers lookup can produce — can't trip the breaker
    // and start rejecting otherwise-healthy traffic.
    errorFilter: (error) =>
      error.errorCode === "HUBSPOT_BAD_REQUEST" || error.errorCode === "HUBSPOT_NOT_FOUND",
  };

  breaker = new Opossum(limiter.wrap(makeHubSpotRequest), breakerOptions);

  // Deliberately no breaker.fallback(): Opossum invokes the fallback for
  // EVERY rejection (not only when the breaker is open), which would
  // silently replace makeHubSpotRequest's classified ApiError (429 vs 5xx vs
  // network, etc.) with one generic message on every single failure. The
  // open-breaker case is instead handled where `request()` catches whatever
  // Opossum itself rejects with below.

  breaker.on("open", () =>
    logger.warn("HubSpot Circuit Breaker OPEN", {
      service: "HubSpotClient",
      action: "CIRCUIT_BREAKER",
    }),
  );
  breaker.on("close", () =>
    logger.info("HubSpot Circuit Breaker CLOSED", {
      service: "HubSpotClient",
      action: "CIRCUIT_BREAKER",
    }),
  );

  return breaker;
};

module.exports = {
  request: async (requestConfig) => {
    initializeHubSpotClient();
    try {
      return await initializeCircuitBreaker().fire(requestConfig);
    } catch (error) {
      // Already classified by makeHubSpotRequest (real HTTP/network failure) — propagate as-is.
      if (error instanceof ApiError && error.errorCode) {
        throw error;
      }
      // Anything else came from Opossum itself: the breaker is open and
      // short-circuited the call, or its own wrapper-level timeout fired
      // before the request could be classified. Either way this is a
      // downstream-unavailable condition, safe to treat as retryable.
      logger.warn("HubSpot request short-circuited by circuit breaker", {
        service: "HubSpotClient",
        action: "CIRCUIT_BREAKER_REJECT",
        message: error.message,
      });
      throw new ApiError(503, "HubSpot Service Unavailable (circuit breaker open)", true, "", {
        errorCode: "HUBSPOT_API_FAILURE",
        retryable: true,
      });
    }
  },
};
