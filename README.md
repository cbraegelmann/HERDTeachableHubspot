# Teachable → HubSpot Integration

Production Node.js backend that syncs Teachable course completions to HubSpot as Marketing Event `ATTENDED` participation. Built per the "Teachable to HubSpot Integration" SOW: real-time webhook sync, a controlled Course ID → Marketing Event mapping, email-based Contact matching (no auto-create), and idempotent, safely-retryable processing. **No database is used or required** — the SOW does not call for one, and none of this integration's actual requirements justify introducing one (see "Idempotency" below).

---

## Requirements

| Tool    | Version |
| ------- | ------- |
| Node.js | >= 18.x (20 or 22 LTS recommended) |
| npm     | >= 9.x  |

No database, no native addons, no external infrastructure beyond Teachable and HubSpot themselves.

---

## Architecture

```
Teachable  --Enrollment.completed webhook-->  This backend  --CRM Contacts Search / Marketing Events API-->  HubSpot
```

1. Teachable fires `Enrollment.completed` at a secret, per-deployment webhook URL.
2. The request is authenticated, validated, and atomically claimed in an in-process idempotency guard **before** any HubSpot call is made.
3. The Teachable Course ID is looked up live against Teachable's own REST API (`GET /v1/courses/{id}`) — no static mapping file. If the course no longer exists, the completion is logged as `COURSE_NOT_FOUND` and skipped.
4. The learner's HubSpot Contact is looked up by email (never created automatically).
5. The course's Marketing Event is idempotently upserted in HubSpot (created if new, name refreshed from Teachable's live response), then `ATTENDED` participation is recorded against it, timestamped with the Teachable completion time.
6. The outcome (success, unmatched contact, ambiguous contact, course not found, or a classified failure) is logged with full context for observability and manual review.

See `src/modules/teachable-webhook/services/enrollmentProcessor.service.js` for the full flow.

---

## Environment Variables

```bash
cp .env.example .env
```

`dotenv-safe` loads `.env` and checks it against `.env.example`, and `src/config/env.js` additionally **fails fast at startup** (in every environment, not just production) if any required variable is missing or invalid — the app refuses to boot in a partially configured state.

Under `NODE_ENV=test` the on-disk `.env` is deliberately **not** loaded: the suite supplies its own values in `tests/helpers/testEnv.js`, and loading a developer's real `.env` made the config tests depend on whichever machine ran them. The required-variable and secret-length checks still run in every environment, test included.

| Variable | Required | Description |
| --- | --- | --- |
| `HUBSPOT_ACCESS_TOKEN` | Yes | HubSpot Private App token. Needs `crm.objects.contacts.read`, `crm.objects.marketing_events.read`, `crm.objects.marketing_events.write`. |
| `HUBSPOT_MARKETING_EVENT_EXTERNAL_ACCOUNT_ID` | Yes | A constant **you** choose (not HubSpot-assigned) identifying this integration as the owner of `externalEventId`-addressed Marketing Events. Pick one value before going live and never change it — changing it later orphans any events already created. |
| `TEACHABLE_WEBHOOK_PATH_SECRET` | Yes | Long random secret (32+ chars, e.g. `openssl rand -hex 32`) embedded in the webhook URL path. Teachable does not sign or otherwise authenticate its webhooks, so this is the only inbound auth mechanism — **the endpoint must be served over HTTPS**. |
| `TEACHABLE_API_KEY` | Yes | From Teachable school admin: **Settings → API**. Used to look up course details live (`GET /v1/courses/{id}`) on every completion — see "Course Lookup" below. |
| `HUBSPOT_API_BASE_URL` | No | Defaults to `https://api.hubapi.com`. |
| `TEACHABLE_API_BASE_URL` | No | Defaults to `https://developers.teachable.com/v1`. |
| `HUBSPOT_MARKETING_EVENT_ORGANIZER` | No | `eventOrganizer` value used when this integration creates/owns a Marketing Event. Defaults to `Teachable`. |
| `MARKETING_EVENT_EXTERNAL_ID_PREFIX` | No | Optional prefix for the deterministic `externalEventId` derived per course (`<prefix><course_id>`). **Defaults to empty**, so `hs_external_event_id` is the bare Teachable Course ID (`2968746`) per the agreed mapping. **If your `.env` still sets this to `teachable-course-`, remove that line** — otherwise the old format stays in force. |
| `MARKETING_EVENT_LEGACY_EXTERNAL_ID_PREFIX` | No | Defaults to `teachable-course-`. Migration safety net: when no Marketing Event resolves under the bare course ID, this prefix is tried before anything is created, so an event created before the ID change is **adopted rather than duplicated**. Set it to an empty string once no pre-migration events remain, to save one lookup per completion for courses that have no event yet. |
| `MAX_PROCESSING_ATTEMPTS` | No | Default `5`. Max claim attempts per enrollment before a retryable failure is marked permanent. |
| `STALE_PROCESSING_TIMEOUT_MS` | No | Default `300000` (5 min). How long an enrollment may sit claimed as in-progress (e.g. after a crash/hang) before it's eligible for reclaim. |
| `PORT`, `NODE_ENV`, `LOG_LEVEL`, `CORS_ALLOWED_ORIGINS` | No | Standard server config, same as before. |

---

## Course Lookup (Live Teachable API)

There is no static mapping file. On every completion, `src/services/teachableCourses.service.js` calls Teachable's own REST API (`GET /v1/courses/{id}`, confirmed against `docs.teachable.com/reference/showcourse`) to resolve the course:

1. **Course found** — its Marketing Event is idempotently upserted in HubSpot (`hubspotMarketingEvents.service.js#upsertOwnedEvent`) using a deterministic `externalEventId` (the Teachable Course ID itself, i.e. `hs_external_event_id = "2968746"`) and the course's *current* name as `eventName` (`hs_event_name`), so a rename on the Teachable side is picked up on the very next completion. If no event resolves under that ID, the pre-migration `teachable-course-<id>` ID is tried before anything is created, so existing events are adopted rather than duplicated. No other event property is written — see `FLOW_SCENARIOS.md` §2. Attendance is then recorded against it, timestamped with Teachable's `completed_at`.
2. **Course not found** (`404`, e.g. deleted or a bad ID) — logged as `COURSE_NOT_FOUND` and skipped. No Marketing Event is created.
3. **Teachable API failure** (timeout, `429`, `5xx`, auth failure) — classified the same way as a HubSpot failure: retryable failures return `503` so Teachable redelivers, up to `MAX_PROCESSING_ATTEMPTS`.

This means **every valid, current Teachable course is synced automatically** — there is no manual mapping/approval step and no way to point a course at a Marketing Event created by hand in the HubSpot UI (that capability existed in an earlier iteration of this integration and was intentionally removed; see `FLOW_SCENARIOS.md`'s Deviation 4 if you need to reintroduce it). This trades the original SOW's recommended "Controlled Mapping" governance model for zero-maintenance course onboarding, at the client's explicit request.

Requires `TEACHABLE_API_KEY` (see Environment Variables above). There is no caching or client-side rate limiting on this lookup — every completion makes one live call to Teachable's API.

---

## Teachable Webhook Setup

1. In Teachable: **Settings → Webhooks → Add Webhook**, event = `Enrollment completed` (requires the Growth plan or above).
2. Target URL: `https://<your-host>/webhooks/teachable/<TEACHABLE_WEBHOOK_PATH_SECRET>` — use the exact same secret as your `.env`.
3. Teachable retries failed deliveries automatically; **after 4 consecutive failures it permanently disables the webhook** until manually re-enabled. This backend is designed around that constraint: only genuinely retryable failures (rate limits, timeouts, 5xx, auth errors) return an HTTP error to Teachable; everything else (validation errors, unmapped courses, unmatched contacts, non-retryable HubSpot errors, and retries that exhaust their budget) returns `200` so a run of unrelated failures can never trip that global auto-disable. See `enrollmentProcessor.service.js`'s `finalizeFailure` for the exact mapping.

Payload handling, verified against real deliveries from a Teachable school:

- **Deliveries arrive as a JSON array** of event envelopes (`[{ "type": ..., "object": {...} }]`), not the bare object shown in Teachable's docs sample. Both shapes are accepted; each event in an array is processed in order and the response carries a per-event `results` array (plus a top-level `status` when there is exactly one event).
- **Other event types are ignored, not rejected.** If the webhook is subscribed to more events than `Enrollment completed` (or to "All events"), payloads such as `User.created`, `Sale.created`, `Enrollment.created`, `LectureProgress.created` are acknowledged with `200` and `IGNORED_EVENT_TYPE`, never `400` — a `400` would count toward the auto-disable above. Subscribing to just `Enrollment completed` is still recommended to avoid the noise.
- Only a **malformed `Enrollment.completed`** returns `400`, since that indicates a real integration problem that retrying cannot fix.
- Real Teachable course IDs are 7-digit numbers (e.g. `2951367`); no mapping file to maintain — see "Course Lookup" above.

---

## Idempotency (No Database)

Duplicate prevention is keyed on the Teachable **Enrollment ID** (`object.id` in the webhook payload — not the webhook delivery id or `course_progress_id`), tracked in a bounded in-process `Map` (`src/services/idempotencyStore.js`). The claim is a single synchronous check-and-set with no `await` in between, so concurrent requests for the same enrollment can't race each other — Node's single-threaded event loop makes this atomic without needing a database transaction.

This is a deliberate choice, not a shortcut. It relies on one verified fact about the actual HubSpot API being used: the Marketing Events attendance endpoint is **idempotent per (contact, interactionDateTime)** — calling it twice with the same contact and the same `joinedAt` timestamp does not create a duplicate attendance record. A database would only be justified if HubSpot's own write weren't already idempotent; it is, so one isn't introduced.

That guarantee holds only for as long as the *same* `interactionDateTime` is re-sent, and the timestamp is **no longer purely payload-derived**: `resolveParticipationTimestamp()` prefers Teachable's authoritative `completed_at` from a live API call and falls back to the payload derivation when that call fails or returns null, so two attempts at the same enrollment can legitimately resolve two different values. The store therefore **pins the timestamp** on the enrollment record the first time it is resolved (`pinParticipation()`), and every later attempt within the process reuses the pinned value instead of re-resolving. Retries and redeliveries always re-send an identical attendance body, which HubSpot no-ops.

The pin dies with the process. Replaying an enrollment **after a restart**, when its attendance was already written, may resolve a different timestamp — and HubSpot's verified idempotency does not cover that case. It needs a redelivery after a restart to happen at all (Teachable does not redeliver a `200` on its own), so it is an accepted, documented residual, not an assumption.

What this store does still guarantee without a database:
- **Duplicate webhook delivery** and **rapid redelivery** within a process's lifetime: skipped for `SUCCEEDED`/`FAILED_PERMANENT`, no repeat HubSpot calls.
- **Concurrent requests for the same enrollment**: exactly one proceeds.
- **Retry after partial failure**: a `FAILED_RETRYABLE` enrollment is reclaimed on redelivery, up to `MAX_PROCESSING_ATTEMPTS`, re-sending the pinned timestamp.
- **A stuck/hung claim within the same process** (not a full crash): reclaimed after `STALE_PROCESSING_TIMEOUT_MS`.
- **Deliberate reprocessing of a review outcome**: `UNMATCHED_CONTACT`, `AMBIGUOUS_CONTACT` and `COURSE_NOT_FOUND` are reclaimed on redelivery (see below). They wrote nothing to HubSpot, so there is nothing to duplicate.

Failed, unmatched, ambiguous, and course-not-found outcomes are logged with full context at `warn`/`error` level for review. The three review outcomes carry the data needed to action them — `learnerEmail`, `courseId`, `courseName`, `enrollmentId`, `hookEventId`, plus `candidateContactIds` for an ambiguous match — both in the log line and on the in-memory record (`idempotencyStore.get(enrollmentId).reviewContext`). In production, ship these structured logs to your log aggregator (CloudWatch, Datadog, etc.) and alert on `FAILED_PERMANENT`/`UNMATCHED_CONTACT`/`AMBIGUOUS_CONTACT`/`COURSE_NOT_FOUND`. Note this is the one place learner PII is logged deliberately: a review that cannot identify the learner is not a review.

**To reprocess after review**: fix the blocker in HubSpot/Teachable (create or merge the contact, restore the course), then resend the event from Teachable (Settings → Webhooks → event history supports manual redelivery). The resend re-runs the enrollment end to end and settles it as `SUCCEEDED`. Resending an already-`SUCCEEDED` enrollment is also safe — it is deduped outright and makes no HubSpot call at all. A `FAILED_PERMANENT` enrollment is *not* reprocessed by a resend (that is what stops an exhausted retry loop); restart the process, or investigate the `errorCode` first.

---

## Local Development

```bash
cp .env.example .env   # fill in the required values
npm install
npm run dev
curl http://localhost:3000/health
```

## Testing

```bash
npm test
```

Jest + Supertest, with HubSpot and Teachable calls mocked (no live accounts required) — no database or other external service needed to run the suite. Covers the full webhook flow: valid/invalid payloads, existing/missing/ambiguous contacts, found/not-found courses, owned-event upsert + attendance addressing, retryable vs. non-retryable HubSpot and Teachable API failures (classified via `nock` against the real HTTP clients), rate limiting, duplicate and concurrent webhook delivery, retry-budget exhaustion, a stale/stuck claim reclaim, and the accepted restart trade-off (state loss is safe because HubSpot's own write is idempotent).

---

## Deployment

1. Provision a Node.js >= 18.x host (AWS or DigitalOcean per the SOW) with a public HTTPS endpoint (required — the webhook secret is in the URL path).
2. Set all required environment variables (see above), including `TEACHABLE_API_KEY`.
3. `npm install && npm start` behind a process manager (PM2/systemd) and a reverse proxy (nginx) for TLS termination — no database to provision or migrate.
4. Register the webhook in Teachable pointing at the deployed URL (see above).

---

## Security

- **Teachable webhook auth**: a secret path token, timing-safe compared (`src/middlewares/teachableWebhookAuth.middleware.js`) — Teachable has no signing/HMAC mechanism to verify against (confirmed against current Teachable docs), so this is the strongest available mitigation. The token is redacted from request logs (`requestLogger.middleware.js`). **HTTPS is mandatory** for this endpoint.
- **HubSpot Contacts**: matched by email only; never auto-created. Ambiguous (>1) matches are logged and skipped, never guessed. Note that the attendance endpoint (`.../attend/email-create`) *would* create a Contact for an unknown email — the contact lookup running first, and stopping on `NOT_FOUND`/`AMBIGUOUS`, is what prevents that. Do not reorder those calls; see `FLOW_SCENARIOS.md` §2 "Contact safety".
- **No course-specific Contact properties** are created — the SOW deliberately keeps the Contact schema clean regardless of course count.
- Helmet, CORS allowlist, HPP, a request body size cap, and a dedicated rate limiter on the webhook route (separate from any other route's budget).
- Structured logs never include the webhook secret, HubSpot access token, or full learner payload bodies beyond what's needed to trace a request.
- Error responses to callers never leak internal error details in production (`NODE_ENV=production` suppresses non-operational error messages).

---

## Known Deviations From the SOW (and Why)

The SOW was written before verifying current Teachable/HubSpot API behavior. Two points were reconciled against official docs during implementation:

1. **No Teachable webhook signature verification exists.** Mitigated with a secret path token instead (see Security above).
2. **`Enrollment.completed` has no dedicated completion-timestamp field** — but Teachable's API does. `GET /v1/courses/{id}/progress?user_id=` returns a real, nullable `completed_at`, which is fetched per completion and used for the participation timestamp. The old derivation (`object.updated_at` → webhook `created`) remains only as a logged fallback for when that value is unavailable or still null. See `FLOW_SCENARIOS.md` Deviation 2.

Additionally, HubSpot's Marketing Events `.../complete` endpoint (which finalizes an event and triggers attendance-duration display) is deliberately **not called** — a Teachable course is an ongoing/evergreen "event" that should stay open to accept future learners' completions, so marking it complete would be semantically wrong. `joinedAt` is still recorded and displayed correctly without it.

3. **Course governance switched from the SOW's recommended "Controlled Mapping" (Option B) to "Automatic" (Option A), backed by a live Teachable API check instead of a static mapping file.** The static `course-mapping.json` was removed entirely and replaced with a live `GET /v1/courses/{id}` lookup per completion (2026-09-16, client request), so courses added/renamed/deleted on the Teachable side need no manual mapping step. See "Course Lookup" above and `FLOW_SCENARIOS.md`'s Deviation 4 for the full reasoning and trade-offs.

## Remaining Client Decisions

- **`TEACHABLE_API_KEY`**: must be generated in Teachable school admin (Settings → API) and set before this app will boot (it's a required env var).
- **No manual Marketing Event override**: if a course ever needs to attach to a Marketing Event created by hand in the HubSpot UI instead of one this integration auto-creates, that capability was removed and would need to be re-added — see `FLOW_SCENARIOS.md`.
- **`joinedAt`/`leftAt` field format**: implemented per the current Marketing Events API changelog (ISO8601), but HubSpot's own documentation snapshots have historically disagreed on this — verify against a live HubSpot sandbox portal before first production use (see `hubspotMarketingEvents.service.js`).
- **Historical completions**: out of scope per the SOW (no migration implemented).
- **Multiple concurrent instances**: the in-memory idempotency store is per-process. If you ever run more than one instance behind a load balancer, each instance dedups independently — HubSpot's own attendance idempotency (see above) still prevents duplicate *data*, but you'd get redundant API calls across instances. If that becomes a real deployment target, that's the point at which a shared store would be a verified requirement, not before.
- **Reconciliation/backfill job**: a HubSpot outage spanning several enrollments' *first* delivery attempts could, in principle, contribute to Teachable's global 4-consecutive-failure auto-disable even though each enrollment's own retry budget is fine. A periodic reconciliation job against Teachable's REST API would close that gap but is outside the SOW's scoped effort — recommended as a future enhancement, with monitoring on `FAILED_RETRYABLE`/503 rate as the minimum mitigation today.
