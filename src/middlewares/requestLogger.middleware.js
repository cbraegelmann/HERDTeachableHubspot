const logger = require("../utils/logger");
const crypto = require("crypto");

// The Teachable webhook path embeds a secret token (see
// teachableWebhookAuth.middleware.js) since Teachable can't sign its
// requests. It must never reach the logs, redact it before logging any URL.
const redactUrl = (url) =>
  url.replace(/(\/webhooks\/teachable\/)([^/?]+)/, "$1[REDACTED]");

const requestLogger = (req, res, next) => {
  // Generate a UUID-like ID using crypto module as fallback
  req.id = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);

  logger.info("Incoming Request", {
    requestId: req.id,
    method: req.method,
    url: redactUrl(req.originalUrl),
    service: "HTTP",
    action: "REQUEST_START",
  });

  next();
};

module.exports = requestLogger;
