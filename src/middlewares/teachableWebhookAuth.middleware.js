const config = require("../config/env");
const timingSafeCompare = require("../utils/timingSafeCompare");
const ApiError = require("../utils/apiError");
const logger = require("../utils/logger");

/**
 * Teachable does not sign or otherwise authenticate its webhook deliveries
 * (confirmed absent from Teachable's own docs), so a long random secret
 * embedded in the URL path — configured as the webhook target in Teachable's
 * dashboard — is the only available inbound authentication mechanism. Compared
 * in constant time to avoid leaking the secret via response-timing differences.
 */
const teachableWebhookAuth = (req, res, next) => {
  const provided = req.params.secretToken;
  const expected = config.teachable.webhookPathSecret;

  if (!timingSafeCompare(provided, expected)) {
    logger.warn("Rejected Teachable webhook: invalid path token", {
      service: "TeachableWebhookAuth",
      action: "VERIFY",
      requestId: req.id,
    });
    return next(
      new ApiError(401, "Invalid webhook token", true, "", {
        errorCode: "AUTH_FAILURE",
        retryable: false,
      }),
    );
  }

  return next();
};

module.exports = teachableWebhookAuth;
