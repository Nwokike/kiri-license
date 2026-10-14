# The KV write budget

The Worker runs on the Cloudflare **free** tier. That is a deliberate choice, and it constrains how this service is written. This document explains the constraint, the arithmetic, and the rules that keep the service inside it.

If you are about to change `src/worker.js` or `src/entitlements.js`, read this first. There is a regression test (`tests/worker.test.js`) that fails the build if a KV write ends up back on a request hot path.

## The constraint

Workers KV on the free tier:

| Operation | Free daily allowance |
|---|---|
| Reads | 100,000 |
| Writes, deletes, lists | **1,000** |
| Writes to the same key | 1 per second |

Reads are not the problem — 100,000 a day is a great deal of traffic. **Writes are the problem**: 1,000 per day across every request the Worker serves, and every write also needs a read in the common pattern.

When the write budget is exhausted, requests to the KV API return `429`, and operations inside a Worker fail. In practice this means `/restore` stops answering and a paying subscriber cannot refresh their token, even though the Worker itself is perfectly healthy.

Cloudflare emails at 50% usage. Treat that email as a bug report, not an event.

## What one request costs

Every KV write below is `PUT`; reads are `GET`.

| Route | Writes | Notes |
|---|---:|---|
| `GET /catalog` | 0 | No KV access. Served from the CDN (`Cache-Control: public, max-age=60`) |
| `GET /health` | 0 | No KV access |
| `GET /success` | 0 | No KV access |
| `GET /plan-check` | 0 | No KV access |
| `GET /mail-test` | 0 | Rate limited in memory |
| `POST /checkout` | 1 | Writes the pending record (email + product) |
| `POST /restore`, `POST /status` | 0 or 1 | 0 when the record already exists and nothing changed; 1 when a payment is first recovered or a subscription actually changed status |
| `POST /webhook` | 1+ | Event-dedupe marker, plus record writes |

A checkout attempt is therefore about 4 writes end to end: the pending record, the entitlement record, and a couple of webhook markers. That is well inside the budget even with a lot of purchases.

Before this document existed, it was far worse: the rate limiter was KV-backed, so **every** request to `/restore` and `/checkout` cost one write to count it, and a checkout watcher polling every 5 seconds for 15 minutes spent ~180 writes per purchase attempt. A handful of purchases in an evening exhausted a full day of writes.

## What the rate limiter costs (nothing)

The fixed-window limiter in `allowRequest` (src/entitlements.js) counts requests in a module-level `Map` in Workers isolate memory. Isolate memory is free and never counts against the KV allowance.

The trade-off is that a limit is enforced **per isolate** — per Cloudflare colo — rather than account-wide, so one client can multiply its allowance by the number of colos in front of the Worker. That is acceptable, because:

- The limiter is a brake on careless retry loops, not a security boundary.
- Every route that matters still verifies the ECDSA signature, the `paid_through` date, and the app scope.
- It fails open, exactly as the old KV version did: an error rates as "allowed", never as "denied".

The `Map` is bounded (`RATE_WINDOW_HARD_CAP`) and pruned, so spoofed `X-Forwarded-For` headers can grow it no further than the cap.

## What is not stored, and why

Two structures that look like they need a mapping do not:

**`tx_ref` → entitlement hash.** Checkout uses the recovery ID as the Flutterwave `tx_ref`, and `recoveryHash(tx_ref)` reproduces the entitlement hash exactly. Writing a `tx:` mapping to KV would spend a write to store something that can be recomputed for free. `findWebhookRecord` (src/worker.js) tries the derived hash first and still falls back to a stored mapping for entitlement records created before this shortcut existed.

**Subscription refresh.** `refreshSubscription` writes the record only when the provider reports something different from what is stored. A refresh that finds nothing new writes nothing.

## The rule for contributors

**Never put a KV write on a request hot path.** If a request arrives on every app launch, resume, or poll, it must not write to KV.

Concretely: before adding a `put` anywhere in a handler, ask whether the value can instead be derived from the request, cached at the CDN, or skipped when the stored value would be identical. If it genuinely must persist, count the writes per request and multiply by the requests you expect per day.

## When the free tier eventually runs out

The budget here is traffic-shaped, not purchase-shaped, so it scales with usage rather than with revenue: steady-state subscribers cost ~1 write per day each only when their subscription status changes. Before adding a paid plan, the two cheapest structural wins are worth more than a plan upgrade — but if the day comes, the $5/month Workers Paid plan lifts the write cap to 1,000,000 per day and removes this entire class of problem.
