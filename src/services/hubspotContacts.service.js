const hubspotClient = require("./hubspot.client");
const ApiError = require("../utils/apiError");
const logger = require("../utils/logger");

/**
 * Looks up a HubSpot Contact by email. Never creates a Contact (the SOW
 * explicitly requires learners with no existing Contact to be logged for
 * review, not auto-created). Returns a discriminated result rather than
 * throwing for "not found" / "ambiguous", since both are expected, valid
 * business outcomes for the caller to record, not failures.
 */
const findContactByEmail = async (email, requestId) => {
  const service = "HubspotContactsService";
  const action = "findContactByEmail";

  const { data } = await hubspotClient.request({
    method: "POST",
    url: "/crm/v3/objects/contacts/search",
    data: {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
      ],
      properties: ["email"],
      limit: 2, // only need to distinguish 0 / 1 / >1 matches
    },
  });

  if (!data || !Array.isArray(data.results) || typeof data.total !== "number") {
    logger.error("Malformed HubSpot contact search response", {
      service,
      action,
      requestId,
    });
    throw new ApiError(
      502,
      "HubSpot returned an unexpected contact search response shape",
      true,
      "",
      { errorCode: "INVALID_HUBSPOT_RESPONSE", retryable: false },
    );
  }

  if (data.total === 0 || data.results.length === 0) {
    return { outcome: "NOT_FOUND" };
  }

  if (data.total > 1 || data.results.length > 1) {
    return { outcome: "AMBIGUOUS", candidateIds: data.results.map((r) => r.id) };
  }

  return { outcome: "FOUND", contactId: data.results[0].id };
};

module.exports = { findContactByEmail };
