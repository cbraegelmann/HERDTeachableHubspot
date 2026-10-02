/**
 * Shared HubSpot response fixtures for the webhook tests.
 *
 * `recordAttendance` no longer trusts the attendance endpoint's own response —
 * it reads the participation back (see
 * hubspotMarketingEvents.service.js#verifyAttendanceRecorded), so every mock
 * that exercises a successful completion has to answer the contact-scoped
 * participations breakdown too. Kept here rather than copied into each suite so
 * the shape stays in one place: it mirrors a real response captured from a live
 * portal on 2026-09-17.
 */

const PARTICIPATIONS_URL_FRAGMENT = "/participations/contacts/";

const isParticipationsLookup = (url) => url.includes(PARTICIPATIONS_URL_FRAGMENT);

/**
 * A stored ATTENDED participation, as the live breakdown endpoint returns it.
 * `attendanceState` is what the verification actually asserts on.
 */
const attendedParticipation = ({
  externalEventId = "101",
  marketingEventId = "evt-1",
  contactId = "42",
  email = "student@example.com",
  attendanceState = "ATTENDED",
  attendanceDurationSeconds = 1,
} = {}) => ({
  total: 1,
  results: [
    {
      id: "853169466103",
      properties: {
        attendanceState,
        occurredAt: 1789642905000,
        attendanceDurationSeconds,
        attendancePercentage: null,
      },
      associations: {
        contact: { contactId: String(contactId), email },
        marketingEvent: {
          marketingEventId: String(marketingEventId),
          externalEventId: String(externalEventId),
          externalAccountId: "test-account",
        },
      },
      createdAt: "2026-09-17T13:32:53.829Z",
    },
  ],
});

/** No participation at all — what a silently discarded attendance looks like. */
const noParticipation = () => ({ total: 0, results: [] });

module.exports = {
  PARTICIPATIONS_URL_FRAGMENT,
  isParticipationsLookup,
  attendedParticipation,
  noParticipation,
};
