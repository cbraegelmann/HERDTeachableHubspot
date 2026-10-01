// Runs before every suite (see jest.config.js `setupFiles`). src/config/env.js
// deliberately does not read the on-disk `.env` under NODE_ENV=test, so every
// value the app needs is supplied here instead. Add new required vars here as
// they are added to REQUIRED_ENV_VARS.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";
process.env.PORT = process.env.PORT || "3000";
