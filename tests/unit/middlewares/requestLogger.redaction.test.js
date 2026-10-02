jest.mock("../../../src/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require("../../../src/utils/logger");
const requestLogger = require("../../../src/middlewares/requestLogger.middleware");

describe("requestLogger secret redaction", () => {
  beforeEach(() => {
    logger.info.mockClear();
  });

  test("redacts the Teachable webhook secret token from the logged URL", () => {
    const req = {
      method: "POST",
      originalUrl: "/webhooks/teachable/super-secret-token-123?x=1",
    };
    const res = { setHeader: jest.fn() };
    const next = jest.fn();

    requestLogger(req, res, next);

    expect(next).toHaveBeenCalled();
    const [, meta] = logger.info.mock.calls[0];
    expect(meta.url).not.toContain("super-secret-token-123");
    expect(meta.url).toBe("/webhooks/teachable/[REDACTED]?x=1");
  });

  test("leaves non-webhook URLs untouched", () => {
    const req = { method: "GET", originalUrl: "/health" };
    const res = { setHeader: jest.fn() };
    const next = jest.fn();

    requestLogger(req, res, next);

    const [, meta] = logger.info.mock.calls[0];
    expect(meta.url).toBe("/health");
  });
});
