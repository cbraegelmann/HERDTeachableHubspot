const app = require("./app");
const config = require("./config/env");
const logger = require("./utils/logger");

// Guarded so the test suite can require the app without binding a port.
if (require.main === module) {
  let server;

  const startServer = async () => {
    server = app.listen(config.port, () => {
      logger.info(`Server listening on port ${config.port} in ${config.nodeEnv} mode`, {
        service: "SYSTEM",
        action: "STARTUP",
      });
    });
  };

  const exitHandler = () => {
    if (server) {
      server.close(() => {
        logger.info("Server closed", { service: "SYSTEM", action: "EXIT" });
        process.exit(1);
      });
    } else {
      process.exit(1);
    }
  };

  const unexpectedErrorHandler = (error) => {
    logger.error("Unexpected error", {
      service: "SYSTEM",
      action: "UNEXPECTED_ERROR",
      error: error.message,
      stack: error.stack,
    });
    exitHandler();
  };

  process.on("uncaughtException", unexpectedErrorHandler);
  process.on("unhandledRejection", unexpectedErrorHandler);

  process.on("SIGTERM", () => {
    logger.info("SIGTERM received", { service: "SYSTEM", action: "SIGTERM" });
    if (server) {
      server.close();
    }
  });

  startServer();
}

module.exports = app;
