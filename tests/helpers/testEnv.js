process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error"; // keep test output quiet
process.env.HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN || "test-hubspot-token";
process.env.HUBSPOT_MARKETING_EVENT_EXTERNAL_ACCOUNT_ID =
  process.env.HUBSPOT_MARKETING_EVENT_EXTERNAL_ACCOUNT_ID || "test-account";
process.env.TEACHABLE_WEBHOOK_PATH_SECRET =
  process.env.TEACHABLE_WEBHOOK_PATH_SECRET || "test-secret-abcdefghijklmnopqrstuvwx";
process.env.TEACHABLE_API_KEY = process.env.TEACHABLE_API_KEY || "test-teachable-api-key";
// Pinned empty so the suite asserts the agreed mapping (hs_external_event_id ==
// the bare Teachable Course ID) regardless of what a developer's local .env
// happens to set. dotenv does not override an already-set variable.
process.env.MARKETING_EVENT_EXTERNAL_ID_PREFIX = "";
process.env.MARKETING_EVENT_LEGACY_EXTERNAL_ID_PREFIX = "teachable-course-";
