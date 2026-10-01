const request = require("supertest");
const app = require("../../src/app");

describe("GET /health", () => {
  it("reports the server as running", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("ok");
    expect(res.body.data.environment).toBe("test");
    expect(typeof res.body.data.uptimeSeconds).toBe("number");
  });

  it("returns a request id header for tracing", async () => {
    const res = await request(app).get("/health");

    expect(res.headers["x-request-id"]).toBeDefined();
  });
});

describe("GET /health/ready", () => {
  it("reports the server as ready when no checks are registered", async () => {
    const res = await request(app).get("/health/ready");

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ready");
  });
});

describe("unknown routes", () => {
  it("returns a structured 404", async () => {
    const res = await request(app).get("/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      errorCode: "NOT_FOUND",
      message: "Not found",
    });
  });
});
