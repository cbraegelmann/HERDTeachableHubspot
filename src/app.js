const express = require("express");
const config = require("./config/env");
const {
  securityMiddleware,
  webhookRateLimiter,
} = require("./middlewares/security.middleware");
const requestLogger = require("./middlewares/requestLogger.middleware");
const {
  errorConverter,
  errorHandler,
} = require("./middlewares/error.middleware");
const compression = require("compression");
const hpp = require("hpp");

const ApiError = require("./utils/apiError");

const teachableWebhookRoutes = require("./modules/teachable-webhook/routes");

const app = express();

// Trust exactly one hop (Vercel's edge proxy) for correct client IPs. Using
// `true` here would trust every hop in X-Forwarded-For, letting a client
// spoof its own IP and bypass IP-based rate limiting (see
// https://express-rate-limit.github.io/ERR_ERL_PERMISSIVE_TRUST_PROXY/).
app.set("trust proxy", 1);

// Security Middlewares
app.use(securityMiddleware);
app.use(hpp());

// Standard Middlewares
// A real Enrollment.completed payload is a few KB at most; capping request
// size bounds memory/CPU spent on an internet-facing endpoint before auth
// or schema validation ever runs.
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));
app.use(compression());
app.use(requestLogger);

// Health Check
app.get("/health", (req, res) => {
  res.status(200).send({ status: "ok", timestamp: new Date().toISOString() });
});

// Teachable -> HubSpot course-completion webhook. Auth is a secret path
// token (see teachableWebhookAuth.middleware.js), not a shared /api prefix
// guard, since this is the only route this backend exposes.
if (config.nodeEnv === "production") {
  app.use("/webhooks/teachable", webhookRateLimiter);
}
app.use("/webhooks/teachable", teachableWebhookRoutes);

// 404 Handler
app.use((req, res, next) => {
  next(new ApiError(404, "Not found"));
});

// Error Handling
app.use(errorConverter);
app.use(errorHandler);

module.exports = app;
