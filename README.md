# kiri-license

A small Cloudflare Worker for Kiri app entitlements powered by Flutterwave.

The Worker owns the payment policy, not the app's private payment credentials. Apps keep the recovery ID and a signed entitlement locally; the Worker verifies Flutterwave, updates entitlement state in one KV namespace, and returns a short-lived signed token for offline use.

## Architecture

```text
Flutter/Flet app
    -> license.kiri.ng/checkout
        -> Flutterwave hosted checkout or Payment Plan
        -> Flutterwave webhook + Worker verification
        -> ENT KV entitlement record
    <- signed entitlement token for local use
```

Supported products are configured in `src/catalog.js` by default and can be overridden with `CATALOG_JSON`:

- `monthly`: recurring Flutterwave Payment Plan, or prepaid one-time mode.
- `yearly`: recurring Flutterwave Payment Plan, or prepaid one-time mode.
- `lifetime`: one-time payment with no expiry.

A universal direct/web entitlement can unlock every app. Play Billing remains the native-store path and is not replaced by this Worker.

## API

### `GET /health`

Returns configuration readiness without returning secrets.

### `GET /catalog`

Returns the public product IDs, kinds, intervals, prices, currency, and scope. Payment Plan IDs and provider credentials are never returned.

### `POST /checkout`

Request:

```json
{
  "app_id": "com.example.app",
  "product_id": "lifetime",
  "email": "buyer@example.com",
  "name": "Optional name"
}
```

Response:

```json
{
  "recovery_id": "KIRI-L-...",
  "checkout_url": "https://checkout.flutterwave.com/...",
  "product": "lifetime",
  "status": "pending",
  "amount": 49.99,
  "currency": "USD"
}
```

The Worker creates a high-entropy recovery ID, stores only its hash in KV, and creates the Flutterwave charge with a server-defined price.

### `POST /restore`

Request:

```json
{
  "recovery_id": "KIRI-L-...",
  "app_id": "com.example.app"
}
```

Response includes `active`, `grace`, `expired`, or `revoked` status. Active records include a signed token for local offline use.

### `POST /status`

Same input as restore, but does not return a token. It is intended for refresh/status checks.

### `POST /webhook`

Flutterwave calls this endpoint. The Worker checks `verif-hash`, deduplicates event IDs, and re-verifies payment data before updating entitlement state.

## KV layout

- `ent:<sha256(recovery_id)>`: the self-contained entitlement record.
- `tx:<sha256(tx_ref)>`: transaction-to-entitlement lookup.
- `sub:<sha256(subscription_id)>`: subscription-to-entitlement lookup.
- `seen:<event_id>`: temporary webhook idempotency marker.
- `pending:<sha256(recovery_id)>`: temporary checkout record.

No raw recovery ID, customer name, email, card information, or full webhook body is stored. Provider transaction and subscription IDs are internal lookup data and are never used as public credentials.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run keys
npm test
npm run check
npm run dev
```

Set real values in `.dev.vars`; never commit that file. The default catalog is 3.99 USD monthly, 24.99 USD yearly, and 49.99 USD lifetime. Add the two Flutterwave Payment Plan IDs to `.dev.vars` or Cloudflare variables when enabling auto-renewal.

For a local KV binding, create a namespace and add its ID under `[[kv_namespaces]]` in `wrangler.toml`, or use the Cloudflare dashboard binding.

## Security

- The Worker Secrets are `FLW_SECRET_KEY`, `FLW_WEBHOOK_HASH`, and `LICENSE_PRIVATE_KEY`. The matching public key is for app-side offline verification and is not a Worker secret.
- Redirect/query status is never treated as proof of payment.
- Amount, currency, reference, product, and successful provider status are checked server-side.
- Restore and checkout are rate-limited by a hashed client identifier.
- Sensitive CORS origins are controlled with `ALLOWED_ORIGINS`.
- Lifetime offline access cannot be revoked while an already-installed app is offline; online restore/refresh is authoritative.

## Google Play

The existing `flet-billing` package remains responsible for Play Billing and StoreKit purchase/restore events. Do not put an unapproved Flutterwave unlock button in a Play-distributed app. The Worker's direct entitlement protocol is intended for web, desktop, direct APK, and other permitted external-checkout surfaces.

## Documentation

- [`docs/client-integration.md`](docs/client-integration.md) is the contract for building and integrating every app client.
- [`DEPLOYMENT.md`](DEPLOYMENT.md) covers Cloudflare Git integration, KV, custom domain, secrets, Flutterwave Test/Live setup, and rollback.
