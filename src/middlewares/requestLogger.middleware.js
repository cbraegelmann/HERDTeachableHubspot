const crypto = require("crypto");
const logger = require("../utils/logger");

// Any path segment carrying a secret (e.g. a webhook token) must be masked
// before it reaches the logs. Add a pattern here as such routes are added.
const REDACTIONS = [];

const redactUrl = (url) =>
  REDACTIONS.reduce((acc, { pattern, replacement }) => acc.replace(pattern, replacement), url);

const requestLogger = (req, res, next) => {
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
