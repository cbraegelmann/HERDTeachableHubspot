const nock = require("nock");

const BASE_URL = "https://api.hubapi.com";

describe("hubspot.client error classification", () => {
  let hubspotClient;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    hubspotClient = require("../../../src/services/hubspot.client");
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test("resolves with data and status on success", async () => {
    nock(BASE_URL).get("/test").reply(200, { ok: true });
    const result = await hubspotClient.request({ method: "GET", url: "/test" });
    expect(result).toEqual({ data: { ok: true }, status: 200 });
  });

  test("classifies 429 as RATE_LIMITED and retryable", async () => {
    nock(BASE_URL).get("/test").reply(429, { message: "slow down" }, { "Retry-After": "2" });
    await expect(hubspotClient.request({ method: "GET", url: "/test" })).rejects.toMatchObject({
      errorCode: "RATE_LIMITED",
      retryable: true,
      statusCode: 429,
    });
  });

  test("classifies 500 as HUBSPOT_API_FAILURE and retryable", async () => {
    nock(BASE_URL).get("/test").reply(500, { message: "oops" });
    await expect(hubspotClient.request({ method: "GET", url: "/test" })).rejects.toMatchObject({
      errorCode: "HUBSPOT_API_FAILURE",
      retryable: true,
    });
  });

  test("classifies 401 as HUBSPOT_AUTH_FAILURE, retryable but systemic", async () => {
    nock(BASE_URL).get("/test").reply(401, { message: "unauthorized" });
    await expect(hubspotClient.request({ method: "GET", url: "/test" })).rejects.toMatchObject({
      errorCode: "HUBSPOT_AUTH_FAILURE",
      retryable: true,
    });
  });

  test("classifies 400 as HUBSPOT_BAD_REQUEST and non-retryable", async () => {
    nock(BASE_URL).get("/test").reply(400, { message: "bad" });
    await expect(hubspotClient.request({ method: "GET", url: "/test" })).rejects.toMatchObject({
      errorCode: "HUBSPOT_BAD_REQUEST",
      retryable: false,
    });
  });

  // Separated from the generic 4xx so that a lookup addressed by an id we chose
  // ourselves can tell "this does not exist yet" apart from "malformed
  // request". Retry semantics are unchanged: still non-retryable.
  test("classifies 404 as HUBSPOT_NOT_FOUND and non-retryable", async () => {
    nock(BASE_URL).get("/test").reply(404, { message: "not found" });
    await expect(hubspotClient.request({ method: "GET", url: "/test" })).rejects.toMatchObject({
      errorCode: "HUBSPOT_NOT_FOUND",
      retryable: false,
      statusCode: 404,
    });
  });

  // A 404 must not count toward the breaker's failure budget: the first
  // completion of every new course can produce one, and a batch of new courses
  // must not be able to open the breaker on otherwise-healthy traffic.
  test("a run of 404s never opens the circuit breaker", async () => {
    nock(BASE_URL).get("/missing").times(12).reply(404, { message: "not found" });

    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        hubspotClient.request({ method: "GET", url: "/missing" }),
      ).rejects.toMatchObject({ errorCode: "HUBSPOT_NOT_FOUND" });
    }

    nock(BASE_URL).get("/healthy").reply(200, { ok: true });
    await expect(hubspotClient.request({ method: "GET", url: "/healthy" })).resolves.toEqual({
      data: { ok: true },
      status: 200,
    });
  });

  test("classifies a network error (no response) as NETWORK_ERROR and retryable", async () => {
    nock(BASE_URL).get("/test").replyWithError({ code: "ECONNREFUSED", message: "connection refused" });
    await expect(hubspotClient.request({ method: "GET", url: "/test" })).rejects.toMatchObject({
      errorCode: "NETWORK_ERROR",
      retryable: true,
    });
  });

  test("opens the circuit breaker after repeated failures and serves the fallback", async () => {
    nock(BASE_URL).get("/test").times(10).reply(500, { message: "down" });

    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await hubspotClient.request({ method: "GET", url: "/test" }).catch(() => {});
    }

    await expect(hubspotClient.request({ method: "GET", url: "/test" })).rejects.toMatchObject({
      errorCode: "HUBSPOT_API_FAILURE",
      retryable: true,
    });
  });
});
