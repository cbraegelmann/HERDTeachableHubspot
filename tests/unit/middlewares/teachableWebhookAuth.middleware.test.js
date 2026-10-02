const SECRET = "a-valid-secret-that-is-long-enough-123456";

describe("teachableWebhookAuth middleware", () => {
  let middleware;

  beforeEach(() => {
    process.env.TEACHABLE_WEBHOOK_PATH_SECRET = SECRET;
    jest.resetModules();
    middleware = require("../../../src/middlewares/teachableWebhookAuth.middleware");
  });

  test("calls next() with no error for the correct token", () => {
    const req = { params: { secretToken: SECRET }, id: "req-1" };
    const next = jest.fn();
    middleware(req, {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  test("rejects an incorrect token with a 401 AUTH_FAILURE error", () => {
    const req = { params: { secretToken: "wrong-token" }, id: "req-1" };
    const next = jest.fn();
    middleware(req, {}, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, errorCode: "AUTH_FAILURE" }),
    );
  });

  test("rejects a missing token with a 401 AUTH_FAILURE error", () => {
    const req = { params: {}, id: "req-1" };
    const next = jest.fn();
    middleware(req, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});
