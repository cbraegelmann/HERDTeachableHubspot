const express = require("express");
const compression = require("compression");
const hpp = require("hpp");

const config = require("./config/env");
const { securityMiddleware, rateLimiter } = require("./middlewares/security.middleware");
const requestLogger = require("./middlewares/requestLogger.middleware");
const { errorConverter, errorHandler } = require("./middlewares/error.middleware");
const ApiError = require("./utils/apiError");

const healthRoutes = require("./modules/health/routes");

const app = express();

// Trust exactly one hop (the platform's edge proxy) for correct client IPs.
// Using `true` here would trust every hop in X-Forwarded-For, letting a client
// spoof its own IP and bypass IP-based rate limiting (see
// https://express-rate-limit.github.io/ERR_ERL_PERMISSIVE_TRUST_PROXY/).
app.set("trust proxy", 1);

// Security Middlewares
app.use(securityMiddleware);
app.use(hpp());

// Standard Middlewares. Capping body size bounds memory/CPU spent on an
// internet-facing endpoint before auth or schema validation ever runs.
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));
app.use(compression());
app.use(requestLogger);

// Health Checks. Mounted before the rate limiter so an uptime monitor polling
// on a short interval can never be throttled out of its own probe.
app.use("/health", healthRoutes);

// Application Routes
if (config.nodeEnv === "production") {
  app.use("/api", rateLimiter);
}
// app.use("/api/<resource>", <resource>Routes);

// 404 Handler
app.use((req, res, next) => {
  next(new ApiError(404, "Not found", true, "", { errorCode: "NOT_FOUND" }));
});

// Error Handling
app.use(errorConverter);
app.use(errorHandler);

module.exports = app;
