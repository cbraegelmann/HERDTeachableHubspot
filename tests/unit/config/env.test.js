const REQUIRED_VARS = [
  "HUBSPOT_ACCESS_TOKEN",
  "HUBSPOT_MARKETING_EVENT_EXTERNAL_ACCOUNT_ID",
  "TEACHABLE_WEBHOOK_PATH_SECRET",
  "TEACHABLE_API_KEY",
];

describe("config/env", () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test.each(REQUIRED_VARS)("throws when %s is missing", (key) => {
    delete process.env[key];
    expect(() => require("../../../src/config/env")).toThrow(
      /Missing required environment variables/,
    );
  });

  test("throws when the webhook secret is too short", () => {
    process.env.TEACHABLE_WEBHOOK_PATH_SECRET = "short";
    expect(() => require("../../../src/config/env")).toThrow(/at least 24 characters/);
  });

  test("loads successfully when all required vars are present", () => {
    expect(() => require("../../../src/config/env")).not.toThrow();
  });

  test("applies documented defaults for optional vars", () => {
    delete process.env.PORT;
    delete process.env.MAX_PROCESSING_ATTEMPTS;
    const config = require("../../../src/config/env");
    expect(config.port).toBe(3000);
    expect(config.processing.maxAttempts).toBe(5);
    expect(config.hubspot.basePath).toBe("https://api.hubapi.com");
  });
});
