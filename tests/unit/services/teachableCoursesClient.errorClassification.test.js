const nock = require("nock");

const BASE_URL = "https://developers.teachable.com/v1";

describe("teachableCourses.client error classification", () => {
  let teachableClient;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    teachableClient = require("../../../src/services/teachableCourses.client");
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test("resolves with data and status on success", async () => {
    nock(BASE_URL).get("/courses/101").reply(200, { course: { id: 101, name: "X" } });
    const result = await teachableClient.request({ method: "GET", url: "/courses/101" });
    expect(result).toEqual({ data: { course: { id: 101, name: "X" } }, status: 200 });
  });

  test("returns a null-data 404 result instead of throwing", async () => {
    nock(BASE_URL).get("/courses/999").reply(404, { message: "not found" });
    const result = await teachableClient.request({ method: "GET", url: "/courses/999" });
    expect(result).toEqual({ data: null, status: 404 });
  });

  test("classifies 429 as RATE_LIMITED and retryable", async () => {
    nock(BASE_URL).get("/courses/101").reply(429, { message: "slow down" });
    await expect(
      teachableClient.request({ method: "GET", url: "/courses/101" }),
    ).rejects.toMatchObject({ errorCode: "RATE_LIMITED", retryable: true, statusCode: 429 });
  });

  test("classifies 401 as TEACHABLE_AUTH_FAILURE and retryable", async () => {
    nock(BASE_URL).get("/courses/101").reply(401, { message: "unauthorized" });
    await expect(
      teachableClient.request({ method: "GET", url: "/courses/101" }),
    ).rejects.toMatchObject({ errorCode: "TEACHABLE_AUTH_FAILURE", retryable: true });
  });

  test("classifies 500 as TEACHABLE_API_FAILURE and retryable", async () => {
    nock(BASE_URL).get("/courses/101").reply(500, { message: "oops" });
    await expect(
      teachableClient.request({ method: "GET", url: "/courses/101" }),
    ).rejects.toMatchObject({ errorCode: "TEACHABLE_API_FAILURE", retryable: true });
  });

  test("classifies a network error (no response) as NETWORK_ERROR and retryable", async () => {
    nock(BASE_URL)
      .get("/courses/101")
      .replyWithError({ code: "ECONNREFUSED", message: "connection refused" });
    await expect(
      teachableClient.request({ method: "GET", url: "/courses/101" }),
    ).rejects.toMatchObject({ errorCode: "NETWORK_ERROR", retryable: true });
  });
});
