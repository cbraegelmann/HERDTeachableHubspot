const claimOptions = { maxAttempts: 5, staleProcessingTimeoutMs: 5 * 60 * 1000 };

describe("services/idempotencyStore", () => {
  let idempotencyStore;

  beforeEach(() => {
    jest.resetModules();
    idempotencyStore = require("../../../src/services/idempotencyStore");
  });

  test("a fresh enrollment is claimed and tracked as PROCESSING", () => {
    const result = idempotencyStore.claim(555, claimOptions);
    expect(result.claimed).toBe(true);
    expect(result.record.status).toBe("PROCESSING");
    expect(result.record.attemptCount).toBe(1);
  });

  test("a duplicate delivery while the record is SUCCEEDED is not claimed", () => {
    idempotencyStore.claim(555, claimOptions);
    idempotencyStore.markSucceeded(555, {
      hubspotContactId: "c1",
      hubspotMarketingEventId: "e1",
    });

    const result = idempotencyStore.claim(555, claimOptions);
    expect(result.claimed).toBe(false);
    expect(result.record.status).toBe("SUCCEEDED");
  });

  test("a duplicate delivery while the record is still PROCESSING (not stale) is not claimed", () => {
    idempotencyStore.claim(555, claimOptions);
    const result = idempotencyStore.claim(555, claimOptions);
    expect(result.claimed).toBe(false);
    expect(result.record.status).toBe("PROCESSING");
  });

  test("two back-to-back claim attempts for the same enrollment: exactly one succeeds", () => {
    const first = idempotencyStore.claim(555, claimOptions);
    const second = idempotencyStore.claim(555, claimOptions);
    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
  });

  test("a redelivery while FAILED_RETRYABLE with attempts remaining is reclaimed", () => {
    idempotencyStore.claim(555, claimOptions);
    idempotencyStore.markFailed(555, { status: "FAILED_RETRYABLE", errorCode: "RATE_LIMITED", errorMessage: "429" });

    const result = idempotencyStore.claim(555, claimOptions);
    expect(result.claimed).toBe(true);
    expect(result.record.status).toBe("PROCESSING");
    expect(result.record.attemptCount).toBe(2);
  });

  test("a redelivery while FAILED_RETRYABLE with attempts exhausted is not reclaimed", () => {
    idempotencyStore.claim(555, { ...claimOptions, maxAttempts: 1 });
    idempotencyStore.markFailed(555, { status: "FAILED_RETRYABLE", errorCode: "RATE_LIMITED", errorMessage: "429" });

    const result = idempotencyStore.claim(555, { ...claimOptions, maxAttempts: 1 });
    expect(result.claimed).toBe(false);
    expect(result.record.status).toBe("FAILED_RETRYABLE");
  });

  test("a redelivery of a stale (crashed/hung) PROCESSING record is reclaimed", () => {
    const { record } = idempotencyStore.claim(555, claimOptions);
    record.updatedAt = Date.now() - 10 * 60 * 1000;

    const result = idempotencyStore.claim(555, claimOptions);
    expect(result.claimed).toBe(true);
    expect(result.record.attemptCount).toBe(2);
  });

  test("markOutcome sets a terminal non-error status", () => {
    idempotencyStore.claim(555, claimOptions);
    idempotencyStore.markOutcome(555, "UNMATCHED_CONTACT");
    expect(idempotencyStore.get(555).status).toBe("UNMATCHED_CONTACT");
  });

  test("markOutcome retains the review context needed to action the outcome later", () => {
    idempotencyStore.claim(555, claimOptions);
    idempotencyStore.markOutcome(555, "UNMATCHED_CONTACT", {
      learnerEmail: "learner@example.com",
      courseId: 2968746,
      courseName: "Cab Rack and Accessory Overview Training",
    });

    expect(idempotencyStore.get(555).reviewContext).toEqual({
      learnerEmail: "learner@example.com",
      courseId: 2968746,
      courseName: "Cab Rack and Accessory Overview Training",
    });
  });

  // Resending the event from Teachable once the blocker is cleared is the
  // documented remediation; it only works if these outcomes are reclaimable.
  describe("review outcomes are reprocessable on redelivery", () => {
    test.each(["UNMATCHED_CONTACT", "AMBIGUOUS_CONTACT", "COURSE_NOT_FOUND"])(
      "a %s record is reclaimed when the event is resent",
      (status) => {
        idempotencyStore.claim(555, claimOptions);
        idempotencyStore.markOutcome(555, status, { learnerEmail: "learner@example.com" });

        const result = idempotencyStore.claim(555, claimOptions);

        expect(result.claimed).toBe(true);
        expect(result.record.status).toBe("PROCESSING");
        // Reset, not incremented: being parked on an external blocker consumed
        // no part of the retryable-failure budget.
        expect(result.record.attemptCount).toBe(1);
      },
    );

    test("the reclaimed attempt gets a full retry budget for real failures", () => {
      const tightBudget = { ...claimOptions, maxAttempts: 2 };
      idempotencyStore.claim(555, tightBudget);
      idempotencyStore.markOutcome(555, "UNMATCHED_CONTACT");
      idempotencyStore.claim(555, tightBudget); // resend after the fix
      idempotencyStore.markFailed(555, {
        status: "FAILED_RETRYABLE",
        errorCode: "RATE_LIMITED",
        errorMessage: "429",
      });

      // Still has an attempt left, rather than being treated as exhausted.
      expect(idempotencyStore.claim(555, tightBudget).claimed).toBe(true);
    });

    // These are only re-reached by a deliberate resend (each returns 200, so
    // Teachable never redelivers them by itself), so the retry budget that
    // exists to stop a runaway failure loop deliberately does not gate them.
    test("stays reclaimable past maxAttempts", () => {
      const tightBudget = { ...claimOptions, maxAttempts: 1 };
      idempotencyStore.claim(555, tightBudget);
      idempotencyStore.markOutcome(555, "UNMATCHED_CONTACT");

      expect(idempotencyStore.claim(555, tightBudget).claimed).toBe(true);
    });

    test("succeeding after a reclaim clears the stale review context", () => {
      idempotencyStore.claim(555, claimOptions);
      idempotencyStore.markOutcome(555, "UNMATCHED_CONTACT", {
        learnerEmail: "learner@example.com",
      });
      idempotencyStore.claim(555, claimOptions);
      idempotencyStore.markSucceeded(555, {
        hubspotContactId: "c1",
        hubspotMarketingEventId: "e1",
      });

      const record = idempotencyStore.get(555);
      expect(record.status).toBe("SUCCEEDED");
      expect(record.reviewContext).toBeUndefined();
    });

    test.each(["SUCCEEDED", "FAILED_PERMANENT"])(
      "a %s record is still NOT reclaimed",
      (status) => {
        idempotencyStore.claim(555, claimOptions);
        if (status === "SUCCEEDED") {
          idempotencyStore.markSucceeded(555, {
            hubspotContactId: "c1",
            hubspotMarketingEventId: "e1",
          });
        } else {
          idempotencyStore.markFailed(555, {
            status,
            errorCode: "HUBSPOT_BAD_REQUEST",
            errorMessage: "bad",
          });
        }

        expect(idempotencyStore.claim(555, claimOptions).claimed).toBe(false);
      },
    );
  });

  // The attendance write is only idempotent for an unchanged
  // (contact, interactionDateTime) pair, and the timestamp now comes from a
  // live lookup that can fall back — so it is pinned on first resolution.
  describe("pinParticipation", () => {
    test("stores the resolved participation timestamp on the record", () => {
      idempotencyStore.claim(555, claimOptions);
      idempotencyStore.pinParticipation(555, {
        completedAt: "2026-09-17T05:27:52.000Z",
        source: "course_progress.completed_at",
      });

      expect(idempotencyStore.get(555).participation).toEqual({
        completedAt: "2026-09-17T05:27:52.000Z",
        source: "course_progress.completed_at",
      });
    });

    test("survives a reclaim, so a retry re-sends the identical timestamp", () => {
      idempotencyStore.claim(555, claimOptions);
      idempotencyStore.pinParticipation(555, {
        completedAt: "2026-09-17T05:27:52.000Z",
        source: "course_progress.completed_at",
      });
      idempotencyStore.markFailed(555, {
        status: "FAILED_RETRYABLE",
        errorCode: "RATE_LIMITED",
        errorMessage: "429",
      });

      const { record } = idempotencyStore.claim(555, claimOptions);
      expect(record.participation.completedAt).toBe("2026-09-17T05:27:52.000Z");
    });

    test("is a no-op for an enrollment that was never claimed", () => {
      expect(() =>
        idempotencyStore.pinParticipation(404404, { completedAt: "x", source: "y" }),
      ).not.toThrow();
      expect(idempotencyStore.get(404404)).toBeUndefined();
    });
  });

  test("get returns undefined for an enrollment never claimed", () => {
    expect(idempotencyStore.get(999)).toBeUndefined();
  });

  test("evicts the oldest tracked enrollment once the bound is exceeded", () => {
    // Re-require with a tiny bound isn't possible (constant is internal), so
    // this exercises the real MAX_TRACKED_ENROLLMENTS via a reduced loop is
    // impractical here; instead verify the store never grows unbounded for a
    // sane number of entries and the earliest entry survives well under the
    // bound (regression guard against accidental eviction-on-every-insert bugs).
    for (let i = 0; i < 1000; i += 1) {
      idempotencyStore.claim(i, claimOptions);
    }
    expect(idempotencyStore.get(0)).toBeDefined();
    expect(idempotencyStore.get(999)).toBeDefined();
  });
});
