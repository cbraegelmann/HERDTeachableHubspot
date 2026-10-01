const path = require("path");

// The on-disk `.env` is never loaded under NODE_ENV=test. This module runs its
// checks at require time and the suite re-requires it to assert them, so
// loading `.env` here would make those tests depend on whatever the machine
// running them happens to have configured. The suite supplies everything it
// needs in tests/helpers/testEnv.js. Validation below still runs in every
// environment, test included.
if (process.env.NODE_ENV !== "test") {
  try {
    require("dotenv-safe").config({
      allowEmptyValues: true,
      example: path.join(__dirname, "../../.env.example"),
    });
  } catch (error) {
    // dotenv-safe throws when `.env` is missing entirely (first-time setup).
    // Real validation of required values happens below, unconditionally, so
    // it's safe to continue and let that check fail loudly instead.
  }
}

// Add every env var the app cannot start without. Keeping this list explicit
// means a half-configured deploy fails at boot rather than on first request.
const REQUIRED_ENV_VARS = [];

const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnvVars.length) {
  throw new Error(
    `Missing required environment variables:\n- ${missingEnvVars.join("\n- ")}\n` +
      "The application refuses to start in a partially configured state. " +
      "See .env.example for the full list of required values.",
  );
}

const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  logLevel: process.env.LOG_LEVEL || "info",
  cors: {
    origins: (process.env.CORS_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  },
};

module.exports = config;
