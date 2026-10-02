const axios = require("axios");
const config = require("../config/env");
const logger = require("../utils/logger");
const ApiError = require("../utils/apiError");
const { isRetryable } = require("../utils/errorCodes");

let teachableClientInstance = null;

const initializeTeachableClient = () => {
  if (teachableClientInstance) return teachableClientInstance;

  teachableClientInstance = axios.create({
    baseURL: config.teachable.apiBaseUrl,
    headers: {
      // Confirmed against https://docs.teachable.com/docs/authentication:
      // Teachable authenticates via a plain `apiKey` header, not Bearer/OAuth.
      apiKey: config.teachable.apiKey,
      Accept: "application/json",
    },
    timeout: 10000,
  });

  return teachableClientInstance;
};

/**
 * Mirrors hubspot.client.js#classifyError: turns a raw axios/network error
 * into our error taxonomy (see src/utils/errorCodes.js). A 404 is handled
 * by the caller as a valid "course not found" result, not an error, so it's
 * classified but never thrown.
 */
const classifyError = (error) => {
  if (!error.response) {
    const isTimeout =
      error.code === "ECONNABORTED" || /timeout/i.test(error.message || "");
    return { errorCode: isTimeout ? "TIMEOUT" : "NETWORK_ERROR", statusCode: 503 };
  }

  const status = error.response.status;

  if (status === 404) {
    return { errorCode: "NOT_FOUND", statusCode: 404 };
  }
  if (status === 429) {
    return { errorCode: "RATE_LIMITED", statusCode: 429 };
  }
  if (status === 401 || status === 403) {
    return { errorCode: "TEACHABLE_AUTH_FAILURE", statusCode: status };
  }
  if (status >= 500) {
    return { errorCode: "TEACHABLE_API_FAILURE", statusCode: status };
  }
  if (status >= 400) {
    return { errorCode: "TEACHABLE_BAD_REQUEST", statusCode: status };
  }

  return { errorCode: "UNEXPECTED_ERROR", statusCode: status || 500 };
};

/**
 * Thin request wrapper for Teachable's REST API. No circuit breaker/rate
 * limiter here (unlike hubspot.client.js) — this is a single read call per
 * enrollment, not a hot write path with the same failure-amplification risk.
 */
const request = async (requestConfig) => {
  try {
    const client = initializeTeachableClient();
    const response = await client(requestConfig);
    return { data: response.data, status: response.status };
  } catch (error) {
    const { errorCode, statusCode } = classifyError(error);

    if (errorCode === "NOT_FOUND") {
      return { data: null, status: 404 };
    }

    const retryable = isRetryable(errorCode);
    logger.error("Teachable API Error", {
      service: "TeachableCoursesClient",
      action: "REQUEST",
      errorCode,
      retryable,
      statusCode,
      url: requestConfig.url,
      method: requestConfig.method,
    });

    throw new ApiError(
      statusCode,
      `Teachable API Error: ${error.response?.data?.message || error.message}`,
      true,
      "",
      { errorCode, retryable },
    );
  }
};

module.exports = { request };
