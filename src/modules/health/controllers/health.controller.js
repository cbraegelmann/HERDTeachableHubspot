const os = require("os");
const config = require("../../../config/env");
const asyncHandler = require("../../../utils/asyncHandler");
const { buildSuccessResponse } = require("../../../utils/apiResponse");
const { version } = require("../../../../package.json");

// Liveness probe. Deliberately dependency-free: it answers "is this process
// up and serving HTTP?" and nothing else, so a flaky downstream API can never
// make a healthy process look dead to a load balancer or uptime monitor.
const getHealth = asyncHandler(async (req, res) => {
  res.status(200).json(
    buildSuccessResponse(
      {
        status: "ok",
        service: "herd-teachable-hubspot",
        version,
        environment: config.nodeEnv,
        uptimeSeconds: Math.floor(process.uptime()),
        hostname: os.hostname(),
        timestamp: new Date().toISOString(),
      },
      "Server is running",
    ),
  );
});

// Readiness probe. Add real dependency checks (HubSpot, Teachable, a DB) to
// `checks` as they are introduced, and fail with 503 when any required one is
// down so traffic is routed away until it recovers.
const getReadiness = asyncHandler(async (req, res) => {
  const checks = [];
  const isReady = checks.every((check) => check.ok);

  res.status(isReady ? 200 : 503).json(
    buildSuccessResponse(
      {
        status: isReady ? "ready" : "not_ready",
        checks,
        timestamp: new Date().toISOString(),
      },
      isReady ? "Server is ready" : "Server is not ready",
    ),
  );
});

module.exports = {
  getHealth,
  getReadiness,
};
