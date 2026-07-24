# Latency investigation: server-side notifications & polling

Answers the README "Latency is high / how often can we make stuff poll?" note.

## TL;DR

The reported latency was **not** caused by the client polling too often. The
client polling is already well behaved (jitter, backoff, pause-when-hidden).
The regression came from the "make notifs server side" work: every mutation
handler (`interest`, `commit`, `close`, `cancel`, `schedule`, `activity/run
create`) **awaited Web Push delivery inline before returning the response**.
Push delivery is one outbound HTTPS request per subscriber to a third-party
push service (FCM/Mozilla/Apple), so a single click paid that round-trip cost
before the UI updated.

Fix: push delivery is now offloaded to `ctx.wait_until`, so it runs after the
response is flushed instead of blocking it. No change to what the user sees —
the notification rows are still written to D1 synchronously, so `sync`/`room`
polls reflect the change immediately.

## Current behavior

### Client polling (already good — left unchanged)

`web/src/usePolling.ts` drives both `useSync` (homepage) and `useRoom`:

- Active interval **6 s** (`FAST_MS`), backing off ×1.5 up to **30 s**
  (`SLOW_MS`) while nothing changes; snaps back to 6 s on any change or on a
  `refresh()` after a mutation.
- **±15 % jitter** so a crowd that loads together doesn't hit the Worker in
  lockstep.
- **Pauses entirely when the tab is hidden** (`document.hidden` +
  `visibilitychange`) and resumes at 6 s when refocused.
- **Change detection** via a `signature()` string, so an unchanged payload
  costs one request and then widens the interval.
- On HTTP 429 it parks at **60 s** (`RATE_LIMIT_MS`).
- In-flight requests are aborted on refresh so a stale response can't clobber
  optimistic state.

Only `/api/*` reaches the Worker (static SPA is served by Cloudflare), so the
budget that matters is roughly `active_tabs / 6s` requests plus one burst per
mutation.

### Server-side notifications (the regression)

Two independent notification paths exist:

1. **Async policy path** (`policy_runtime::emit_event` → `domain_events` row +
   Queue enqueue → queue consumer evaluates policy and delivers push). This is
   the "proper" async design and is *not* the problem.
2. **Direct push path** (`api::push_people` → `push::send_to_people`). This ran
   **inline in the request handler** on `activity_create`, `activity_create_run`,
   `run_interest`, `run_commit`, `run_withdraw` and the proposer actions
   (`close`/`cancel`/`schedule`). It:
   - queries subscriptions,
   - VAPID-signs a JWT (p256 ECDSA — CPU),
   - RFC 8291-encrypts the payload,
   - and `fetch()`es the push endpoint for each subscriber.

   `push.rs` already fans the per-subscriber `fetch`es out concurrently
   (cost ≈ `max(RTT)` instead of `sum(RTT)`), but the handler still `await`ed
   the whole fan-out before building the response. So every click added a full
   push-service round-trip (often 100–500 ms, worse on cold TLS) to user-facing
   latency, on top of the several sequential D1 queries the handler already does.

## Root-cause hypotheses (ranked)

1. **[Confirmed, primary] Push delivery on the critical request path.**
   `push_people(...).await?` inside mutation handlers blocks the response on
   third-party push-service round-trips + VAPID signing. Directly matches the
   "new server side notifications" timing in git history.
2. **[Secondary] Synchronous `emit_event` per mutation.** Each mutation also
   does an extra `domain_events` INSERT + Queue `send` subrequest inline. Queue
   send is same-region and fast relative to push, so it's a minor contributor.
   Left as-is to preserve the durable-write ordering; a candidate follow-up is
   to enqueue after responding.
3. **[Minor] Sequential D1 queries per mutation** (reap → upsert → refresh →
   notify_* → insert_notification). Inherent to the data model; not the
   regression. Not touched.
4. **[Ruled out] Client polling too frequent.** 6 s active with backoff, jitter
   and hidden-tab pausing is already conservative for a live-coordination UI.

## Recommended polling cadence

The existing cadence is a good answer to "how often can we poll?" — keep it:

- **Active / focused tab: ~5–6 s.** Fast enough that live participant counts
  feel responsive; the immediate `refresh()` after a local mutation already
  makes *your own* actions feel instant, so polling only covers *other people's*
  changes.
- **Idle (no changes): back off to ~30 s.** Already implemented via ×1.5
  backoff keyed on the payload signature.
- **Hidden tab: don't poll.** Already implemented. Server-side push is what
  should wake a backgrounded/closed client, which is exactly why keeping push
  delivery reliable (now via `wait_until`) matters.
- **Jitter: keep ±15 %** to avoid thundering herds when a run goes ready.

Further options, in rough order of value (not implemented here — larger
changes):

- **Conditional requests (ETag / `If-Modified-Since`) on `/api/sync` and
  `/api/rooms/:code`.** The client already computes a change signature; moving
  that server-side lets unchanged polls return `304` with an empty body,
  cutting bandwidth and serialization cost. Biggest remaining win.
- **Long-polling / hanging GET** on `sync`/`room` (hold the request up to
  ~25 s, return early on change). Cuts request count dramatically but needs a
  wake mechanism (Durable Object or Queue) and careful Worker-time budgeting;
  more invasive.
- **Rely more on Web Push** to eliminate background polling entirely once push
  reliability is verified.

## Changes made (this branch)

Backend only; minimal and reversible.

- `src/lib.rs`: capture the fetch `Context` (was `_ctx`) and build the router
  with `Router::with_data(ctx)` so handlers can reach `ctx.wait_until`.
- `src/api.rs`:
  - All 26 route handlers now take `RouteContext<Context>` instead of
    `RouteContext<()>` (mechanical; the router data is the fetch `Context`).
  - `push_people` rewritten from an `async fn` that `await`ed delivery into a
    sync fn that offloads delivery to `ctx.wait_until` (clones `Env`, re-opens
    the D1 binding inside the deferred future, logs failures). Notification
    rows are still written synchronously beforehand, so polling is unaffected.
  - The 7 call sites drop `.await?` and pass `&ctx.data` (the `Context`).
- The maintenance cron path (`src/lib.rs::run_maintenance` →
  `push::send_to_people`) is left awaited — it runs in the scheduled handler,
  not a user request, so latency there is irrelevant.

Not changed: client polling (`usePolling.ts` et al.) — already optimal; the
async policy queue path; the per-mutation D1 query sequence.

## Verification

- `cargo check --target wasm32-unknown-unknown` — clean.
- `cargo test` — 57 passed, 0 failed.
- No TypeScript changed, so the `web` build/test were not required for these
  changes.
</content>
</invoke>
