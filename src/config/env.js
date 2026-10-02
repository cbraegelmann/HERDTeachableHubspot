const path = require("path");

// The on-disk `.env` is never loaded under NODE_ENV=test. This module runs its
// checks at require time, and the suite re-requires it to assert them, so
// loading `.env` here made those tests depend on whether the machine running
// them happens to have a populated `.env`: a variable a test had just deleted
// was silently re-injected on the next require, and the "throws when X is
// missing" cases could not fail. The suite supplies everything it needs in
// tests/helpers/testEnv.js. Validation below is unchanged and still runs
// unconditionally in every environment, including test.
if (process.env.NODE_ENV !== "test") {
  try {
    require("dotenv-safe").config({
      allowEmptyValues: true,
      example: path.join(__dirname, "../../.env.example"),
    });
  } catch (error) {
    // dotenv-safe throws if .env is missing entirely (e.g. first-time setup docs
    // reference this). Real validation of required values happens below,
    // unconditionally, so it's safe to continue and let that check fail loudly.
  }
}

const REQUIRED_ENV_VARS = [
  "HUBSPOT_ACCESS_TOKEN",
  "HUBSPOT_MARKETING_EVENT_EXTERNAL_ACCOUNT_ID",
  "TEACHABLE_WEBHOOK_PATH_SECRET",
  "TEACHABLE_API_KEY",
];

const MIN_WEBHOOK_SECRET_LENGTH = 24;

const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnvVars.length) {
  throw new Error(
    `Missing required environment variables:\n- ${missingEnvVars.join("\n- ")}\n` +
      "The application refuses to start in a partially configured state. " +
      "See .env.example for the full list of required values.",
  );
}

if (
  process.env.TEACHABLE_WEBHOOK_PATH_SECRET &&
  process.env.TEACHABLE_WEBHOOK_PATH_SECRET.length < MIN_WEBHOOK_SECRET_LENGTH
) {
  throw new Error(
    `TEACHABLE_WEBHOOK_PATH_SECRET must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters ` +
      "long (it is the only authentication mechanism for the inbound Teachable webhook, " +
      "since Teachable does not sign its webhook payloads).",
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
  hubspot: {
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
    basePath: process.env.HUBSPOT_API_BASE_URL || "https://api.hubapi.com",
    marketingEvents: {
      externalAccountId: process.env.HUBSPOT_MARKETING_EVENT_EXTERNAL_ACCOUNT_ID,
      // Defaults to empty: hs_external_event_id must be the bare Teachable
      // Course ID ("2968746"), per the agreed mapping. Set
      // MARKETING_EVENT_EXTERNAL_ID_PREFIX to restore a namespace prefix.
      externalIdPrefix: process.env.MARKETING_EVENT_EXTERNAL_ID_PREFIX || "",
      // Events created before the switch to bare course IDs live under this
      // prefix. A course whose event is not found under the bare ID is looked
      // up here before anything is created, so an existing event is adopted
      // rather than duplicated. Set to an empty string to disable the fallback
      // once no pre-migration events remain.
      legacyExternalIdPrefix:
        process.env.MARKETING_EVENT_LEGACY_EXTERNAL_ID_PREFIX ?? "teachable-course-",
      organizer: process.env.HUBSPOT_MARKETING_EVENT_ORGANIZER || "Teachable",
    },
  },
  teachable: {
    webhookPathSecret: process.env.TEACHABLE_WEBHOOK_PATH_SECRET,
    apiKey: process.env.TEACHABLE_API_KEY,
    // Confirmed against https://docs.teachable.com/reference/showcourse (2026-09-16).
    apiBaseUrl: process.env.TEACHABLE_API_BASE_URL || "https://developers.teachable.com/v1",
  },
  processing: {
    maxAttempts: Number(process.env.MAX_PROCESSING_ATTEMPTS) || 5,
    staleProcessingTimeoutMs:
      Number(process.env.STALE_PROCESSING_TIMEOUT_MS) || 5 * 60 * 1000,
  },
};

module.exports = config;
