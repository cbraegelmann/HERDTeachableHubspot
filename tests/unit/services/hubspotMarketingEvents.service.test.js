jest.mock("../../../src/services/hubspot.client", () => ({ request: jest.fn() }));
const hubspotClient = require("../../../src/services/hubspot.client");
const {
  upsertOwnedEvent,
  recordAttendance,
} = require("../../../src/services/hubspotMarketingEvents.service");

describe("hubspotMarketingEvents.service", () => {
  beforeEach(() => {
    hubspotClient.request.mockReset();
  });

  describe("upsertOwnedEvent", () => {
    // The identifiers lookup that runs first on every call.
    const mockNoExistingEvent = () =>
      hubspotClient.request.mockResolvedValueOnce({ data: { total: 0, results: [] }, status: 200 });

    test("creates the event and returns the top-level objectId when none exists", async () => {
      mockNoExistingEvent();
      hubspotClient.request.mockResolvedValueOnce({ data: { objectId: "evt-1" }, status: 200 });

      const result = await upsertOwnedEvent(
        { externalEventId: "101", eventName: "X" },
        "req-1",
      );

      expect(result).toEqual({ objectId: "evt-1", externalEventId: "101" });
      expect(hubspotClient.request).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          method: "GET",
          url: "/marketing/v3/marketing-events/101/identifiers",
        }),
      );
      // Single-event create, NOT the /events/upsert batch endpoint: that one
      // answers COMPLETE with an empty results array and persists nothing.
      expect(hubspotClient.request).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: "POST",
          url: "/marketing/v3/marketing-events/events",
          data: expect.objectContaining({
            externalEventId: "101",
            eventName: "X",
          }),
        }),
      );
    });

    // hs_event_description / hs_event_url / hs_event_type have no
    // requirement-defined value, and hs_start_datetime / hs_end_datetime are
    // not a learner's completion time. None of them may be written.
    test("writes only externalEventId, eventName and eventOrganizer — no invented properties", async () => {
      mockNoExistingEvent();
      hubspotClient.request.mockResolvedValueOnce({ data: { objectId: "evt-1" }, status: 200 });

      await upsertOwnedEvent({ externalEventId: "101", eventName: "X" }, "req-1");

      const createBody = hubspotClient.request.mock.calls[1][0].data;
      expect(Object.keys(createBody).sort()).toEqual([
        "eventName",
        "eventOrganizer",
        "externalAccountId",
        "externalEventId",
      ]);
    });

    // HubSpot answers "no such event" in two shapes: 200 with an empty results
    // array, and 404. Before the 404 was handled, it was classified as a
    // generic non-retryable 4xx and failed the enrollment permanently — on the
    // very path every brand-new course takes on its first completion.
    describe("a 404 from the identifiers lookup means 'not created yet'", () => {
      const notFound = () =>
        Object.assign(new Error("HubSpot Error: not found"), {
          errorCode: "HUBSPOT_NOT_FOUND",
          statusCode: 404,
          retryable: false,
        });

      test("creates the event instead of failing when the bare-id lookup 404s", async () => {
        hubspotClient.request.mockRejectedValueOnce(notFound());
        hubspotClient.request.mockResolvedValueOnce({ data: { objectId: "evt-1" }, status: 200 });

        const result = await upsertOwnedEvent({ externalEventId: "101", eventName: "X" }, "req-1");

        expect(result).toEqual({ objectId: "evt-1", externalEventId: "101" });
        expect(hubspotClient.request).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            method: "POST",
            url: "/marketing/v3/marketing-events/events",
            data: expect.objectContaining({ externalEventId: "101", eventName: "X" }),
          }),
        );
      });

      test("falls through to the legacy lookup when the bare-id lookup 404s", async () => {
        hubspotClient.request.mockRejectedValueOnce(notFound());
        hubspotClient.request.mockResolvedValueOnce({
          data: { total: 1, results: [{ objectId: "evt-legacy" }] },
          status: 200,
        });
        hubspotClient.request.mockResolvedValueOnce({ data: {}, status: 200 });

        const result = await upsertOwnedEvent(
          {
            externalEventId: "101",
            legacyExternalEventId: "teachable-course-101",
            eventName: "Renamed",
          },
          "req-1",
        );

        // The pre-migration event is still adopted, not duplicated.
        expect(result).toEqual({ objectId: "evt-legacy", externalEventId: "teachable-course-101" });
        expect(
          hubspotClient.request.mock.calls.filter(
            ([cfg]) => cfg.url === "/marketing/v3/marketing-events/events",
          ),
        ).toHaveLength(0);
      });

      test("creates when both the bare and the legacy lookup 404", async () => {
        hubspotClient.request.mockRejectedValueOnce(notFound());
        hubspotClient.request.mockRejectedValueOnce(notFound());
        hubspotClient.request.mockResolvedValueOnce({ data: { objectId: "evt-new" }, status: 200 });

        const result = await upsertOwnedEvent(
          {
            externalEventId: "101",
            legacyExternalEventId: "teachable-course-101",
            eventName: "X",
          },
          "req-1",
        );

        expect(result).toEqual({ objectId: "evt-new", externalEventId: "101" });
      });

      // Only 404 means "not there". Everything else keeps its existing
      // classification so retryable failures still reach Teachable as a 503.
      test.each([
        ["HUBSPOT_API_FAILURE", true],
        ["RATE_LIMITED", true],
        ["HUBSPOT_AUTH_FAILURE", true],
        ["HUBSPOT_BAD_REQUEST", false],
      ])("rethrows a %s from the identifiers lookup untouched", async (errorCode, retryable) => {
        hubspotClient.request.mockRejectedValueOnce(
          Object.assign(new Error("boom"), { errorCode, retryable }),
        );

        await expect(
          upsertOwnedEvent({ externalEventId: "101", eventName: "X" }, "req-1"),
        ).rejects.toMatchObject({ errorCode, retryable });
        // Nothing was created off the back of a failed lookup.
        expect(hubspotClient.request).toHaveBeenCalledTimes(1);
      });
    });

    test("updates the existing event instead of creating when the lookup resolves one", async () => {
      hubspotClient.request.mockResolvedValueOnce({
        data: { total: 1, results: [{ objectId: "evt-existing" }] },
        status: 200,
      });
      hubspotClient.request.mockResolvedValueOnce({ data: {}, status: 200 });

      const result = await upsertOwnedEvent(
        { externalEventId: "101", eventName: "Renamed" },
        "req-1",
      );

      expect(result).toEqual({ objectId: "evt-existing", externalEventId: "101" });
      expect(hubspotClient.request).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: "PATCH",
          url: "/marketing/v3/marketing-events/evt-existing",
          data: { eventName: "Renamed" },
        }),
      );
    });

    // Migration from prefixed external ids to bare course ids. An event that
    // already exists under the legacy id must be adopted, never duplicated.
    describe("legacy external id fallback", () => {
      test("adopts the pre-migration event and keeps addressing it by its legacy id", async () => {
        mockNoExistingEvent(); // bare id: miss
        hubspotClient.request.mockResolvedValueOnce({
          data: { total: 1, results: [{ objectId: "evt-legacy" }] },
          status: 200,
        });
        hubspotClient.request.mockResolvedValueOnce({ data: {}, status: 200 });

        const result = await upsertOwnedEvent(
          {
            externalEventId: "101",
            legacyExternalEventId: "teachable-course-101",
            eventName: "Renamed",
          },
          "req-1",
        );

        expect(result).toEqual({
          objectId: "evt-legacy",
          externalEventId: "teachable-course-101",
        });
        expect(hubspotClient.request).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            method: "GET",
            url: "/marketing/v3/marketing-events/teachable-course-101/identifiers",
          }),
        );
        expect(hubspotClient.request).toHaveBeenNthCalledWith(
          3,
          expect.objectContaining({
            method: "PATCH",
            url: "/marketing/v3/marketing-events/evt-legacy",
          }),
        );
        // Nothing may be created when a legacy event was found.
        expect(
          hubspotClient.request.mock.calls.filter(
            ([cfg]) => cfg.url === "/marketing/v3/marketing-events/events",
          ),
        ).toHaveLength(0);
      });

      test("creates under the bare id when neither the bare nor the legacy id resolves", async () => {
        mockNoExistingEvent();
        mockNoExistingEvent();
        hubspotClient.request.mockResolvedValueOnce({ data: { objectId: "evt-new" }, status: 200 });

        const result = await upsertOwnedEvent(
          {
            externalEventId: "101",
            legacyExternalEventId: "teachable-course-101",
            eventName: "X",
          },
          "req-1",
        );

        expect(result).toEqual({ objectId: "evt-new", externalEventId: "101" });
        expect(hubspotClient.request.mock.calls[2][0].data.externalEventId).toBe("101");
      });

      test("never looks up the legacy id when the bare id already resolves", async () => {
        hubspotClient.request.mockResolvedValueOnce({
          data: { total: 1, results: [{ objectId: "evt-current" }] },
          status: 200,
        });
        hubspotClient.request.mockResolvedValueOnce({ data: {}, status: 200 });

        await upsertOwnedEvent(
          {
            externalEventId: "101",
            legacyExternalEventId: "teachable-course-101",
            eventName: "X",
          },
          "req-1",
        );

        expect(
          hubspotClient.request.mock.calls.filter(([cfg]) =>
            cfg.url.includes("teachable-course-101"),
          ),
        ).toHaveLength(0);
      });

      test("skips the legacy lookup entirely when no legacy id is configured", async () => {
        mockNoExistingEvent();
        hubspotClient.request.mockResolvedValueOnce({ data: { objectId: "evt-new" }, status: 200 });

        await upsertOwnedEvent(
          { externalEventId: "101", legacyExternalEventId: null, eventName: "X" },
          "req-1",
        );

        expect(hubspotClient.request).toHaveBeenCalledTimes(2);
      });
    });

    test("falls back to updating the conflicting event when create hits UNIQUE_VALUE_CONFLICT", async () => {
      mockNoExistingEvent();
      const conflict = Object.assign(new Error("conflict"), {
        errorCode: "HUBSPOT_BAD_REQUEST",
        hubspotResponse: {
          errorType: "UNIQUE_VALUE_CONFLICT",
          errorTokens: { existingObjectId: ["evt-winner"] },
        },
      });
      hubspotClient.request.mockRejectedValueOnce(conflict);
      hubspotClient.request.mockResolvedValueOnce({ data: {}, status: 200 });

      const result = await upsertOwnedEvent(
        { externalEventId: "101", eventName: "X" },
        "req-1",
      );

      expect(result).toEqual({ objectId: "evt-winner", externalEventId: "101" });
      expect(hubspotClient.request).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          method: "PATCH",
          url: "/marketing/v3/marketing-events/evt-winner",
        }),
      );
    });

    test("rethrows a create failure that is not a unique-value conflict", async () => {
      mockNoExistingEvent();
      hubspotClient.request.mockRejectedValueOnce(
        Object.assign(new Error("boom"), {
          errorCode: "HUBSPOT_API_FAILURE",
          hubspotResponse: { status: "error" },
        }),
      );

      await expect(
        upsertOwnedEvent({ externalEventId: "x", eventName: "X" }, "req-1"),
      ).rejects.toMatchObject({ errorCode: "HUBSPOT_API_FAILURE" });
    });

    test("throws INVALID_HUBSPOT_RESPONSE when create returns no objectId", async () => {
      mockNoExistingEvent();
      hubspotClient.request.mockResolvedValueOnce({ data: {}, status: 200 });

      await expect(
        upsertOwnedEvent({ externalEventId: "x", eventName: "X" }, "req-1"),
      ).rejects.toMatchObject({ errorCode: "INVALID_HUBSPOT_RESPONSE", retryable: false });
    });
  });

  describe("recordAttendance", () => {
    const attendeeRecorded = { data: { results: [{ vid: 1, email: "a@b.com" }] }, status: 200 };

    test("sends the inputs[] body with an epoch-ms interactionDateTime and externalAccountId as a query param", async () => {
      hubspotClient.request.mockResolvedValue(attendeeRecorded);
      const result = await recordAttendance(
        {
          externalEventId: "102",
          resolvedObjectId: "evt-102",
          email: "a@b.com",
          joinedAtIso: "2026-01-01T00:00:00.000Z",
        },
        "req-1",
      );

      expect(hubspotClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          url: "/marketing/v3/marketing-events/attendance/102/attend/email-create",
          params: expect.objectContaining({ externalAccountId: expect.anything() }),
          // properties.joinedAt/leftAt are REQUIRED: without them HubSpot
          // answers 200 and silently stores nothing. Verified live 2026-09-17.
          data: {
            inputs: [
              {
                email: "a@b.com",
                interactionDateTime: Date.parse("2026-01-01T00:00:00.000Z"),
                properties: {
                  joinedAt: "2026-01-01T00:00:00.000Z",
                  // Strictly later than joinedAt: an identical instant is
                  // rejected with JOINED_AT_IS_LATER_THAN_LEFT_AT_FOR_EMAIL.
                  leftAt: "2026-01-01T00:00:00.001Z",
                },
              },
            ],
          },
        }),
      );
      expect(result).toEqual({ hubspotMarketingEventId: "evt-102" });
    });

    test("falls back to externalEventId as hubspotMarketingEventId when no resolvedObjectId is given", async () => {
      hubspotClient.request.mockResolvedValue(attendeeRecorded);
      const result = await recordAttendance(
        {
          externalEventId: "102",
          email: "a@b.com",
          joinedAtIso: "2026-01-01T00:00:00.000Z",
        },
        "req-1",
      );

      expect(result).toEqual({ hubspotMarketingEventId: "102" });
    });

    // joinedAt must be strictly earlier than leftAt, or HubSpot answers 200
    // with an errors[] entry and stores nothing. Verified live 2026-09-17.
    test("always sends leftAt strictly after joinedAt", async () => {
      hubspotClient.request.mockResolvedValue(attendeeRecorded);
      await recordAttendance(
        { externalEventId: "102", email: "a@b.com", joinedAtIso: "2026-01-01T00:00:00.000Z" },
        "req-1",
      );

      const { properties } = hubspotClient.request.mock.calls[0][0].data.inputs[0];
      expect(Date.parse(properties.leftAt)).toBeGreaterThan(Date.parse(properties.joinedAt));
    });

    // A 200 carrying errors[] means nothing was stored. Treating it as success
    // is how the missing joinedAt/leftAt went unnoticed in production.
    test("throws when a 200 response carries per-input validation errors", async () => {
      hubspotClient.request.mockResolvedValue({
        status: 200,
        data: {
          status: "COMPLETE",
          results: [],
          numErrors: 1,
          errors: [
            {
              category: "VALIDATION_ERROR",
              subCategory: "AttendanceValidationError.JOINED_AT_IS_LATER_THAN_LEFT_AT_FOR_EMAIL",
              message: "joinedAt param must be earlier than leftAt for `a@b.com`",
            },
          ],
        },
      });

      await expect(
        recordAttendance(
          { externalEventId: "102", email: "a@b.com", joinedAtIso: "2026-01-01T00:00:00.000Z" },
          "req-1",
        ),
      ).rejects.toMatchObject({ errorCode: "INVALID_HUBSPOT_RESPONSE", retryable: false });
    });

    test("throws INVALID_HUBSPOT_RESPONSE on a non-2xx status", async () => {
      hubspotClient.request.mockResolvedValue({ data: {}, status: 500 });
      await expect(
        recordAttendance(
          {
            externalEventId: "102",
            email: "a@b.com",
            joinedAtIso: "2026-01-01T00:00:00.000Z",
          },
          "req-1",
        ),
      ).rejects.toMatchObject({ errorCode: "INVALID_HUBSPOT_RESPONSE" });
    });

    // HubSpot returns an empty results array both when the contact already
    // attends the event and when it silently ignored the input. Re-delivery of
    // an already-recorded attendance must not be failed.
    test("succeeds when HTTP 200 comes back with an empty results array", async () => {
      hubspotClient.request.mockResolvedValue({
        data: { status: "COMPLETE", results: [] },
        status: 200,
      });
      await expect(
        recordAttendance(
          {
            externalEventId: "102",
            resolvedObjectId: "evt-102",
            email: "a@b.com",
            joinedAtIso: "2026-01-01T00:00:00.000Z",
          },
          "req-1",
        ),
      ).resolves.toEqual({ hubspotMarketingEventId: "evt-102" });
    });
  });
});
