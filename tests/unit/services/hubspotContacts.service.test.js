jest.mock("../../../src/services/hubspot.client", () => ({ request: jest.fn() }));
const hubspotClient = require("../../../src/services/hubspot.client");
const { findContactByEmail } = require("../../../src/services/hubspotContacts.service");

describe("hubspotContacts.service#findContactByEmail", () => {
  beforeEach(() => {
    hubspotClient.request.mockReset();
  });

  test("returns NOT_FOUND when the search yields zero results", async () => {
    hubspotClient.request.mockResolvedValue({ data: { results: [], total: 0 }, status: 200 });
    const result = await findContactByEmail("nobody@example.com", "req-1");
    expect(result).toEqual({ outcome: "NOT_FOUND" });
  });

  test("returns FOUND with the contact id for exactly one match", async () => {
    hubspotClient.request.mockResolvedValue({
      data: { results: [{ id: "42" }], total: 1 },
      status: 200,
    });
    const result = await findContactByEmail("someone@example.com", "req-1");
    expect(result).toEqual({ outcome: "FOUND", contactId: "42" });
  });

  test("returns AMBIGUOUS with candidate ids for more than one match, never guessing", async () => {
    hubspotClient.request.mockResolvedValue({
      data: { results: [{ id: "1" }, { id: "2" }], total: 2 },
      status: 200,
    });
    const result = await findContactByEmail("dup@example.com", "req-1");
    expect(result.outcome).toBe("AMBIGUOUS");
    expect(result.candidateIds).toEqual(["1", "2"]);
  });

  test("sends the correct search request shape", async () => {
    hubspotClient.request.mockResolvedValue({ data: { results: [], total: 0 }, status: 200 });
    await findContactByEmail("someone@example.com", "req-1");
    expect(hubspotClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "/crm/v3/objects/contacts/search",
        data: expect.objectContaining({
          filterGroups: [
            { filters: [{ propertyName: "email", operator: "EQ", value: "someone@example.com" }] },
          ],
        }),
      }),
    );
  });

  test.each([
    ["missing results array", { total: 0 }],
    ["missing total", { results: [] }],
    ["results not an array", { results: "nope", total: 0 }],
    ["null data", null],
  ])("throws INVALID_HUBSPOT_RESPONSE for a malformed shape (%s)", async (_label, data) => {
    hubspotClient.request.mockResolvedValue({ data, status: 200 });
    await expect(findContactByEmail("someone@example.com", "req-1")).rejects.toMatchObject({
      errorCode: "INVALID_HUBSPOT_RESPONSE",
      retryable: false,
    });
  });
});
