# Kiri License client integration

This document is the contract for every direct/web Flutter or Flet app that uses the Kiri license Worker.

## Public configuration

```text
Base URL: https://license.kiri.ng
Public verification key: MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-YfZ-yKdG3wYF1IR0XcpJH4RclABnddMmAGXFI2J8sbC4gWY2POKc8hVrn0_uHxDZ9ufzwzg4buUimW-IEw4Uw
```

The public key is safe to ship in an app. The private signing key belongs only in the Worker and must never be sent to a client or committed to a repository.

## Product catalog

| Product ID | Price | Billing |
|---|---:|---|
| `monthly` | USD 3.99 | Flutterwave Payment Plan, monthly |
| `yearly` | USD 24.99 | Flutterwave Payment Plan, yearly |
| `lifetime` | USD 49.99 | One-time payment |

The current Flutterwave plan IDs are kept in the Worker configuration:

```text
monthly: 170277
yearly: 170278
```

## 1. Load the catalog

```http
GET https://license.kiri.ng/catalog
```

The response is safe to cache. It contains product IDs, amounts, currency, interval, and scope. It never contains Flutterwave secrets or plan IDs.

## 2. Start checkout

```http
POST https://license.kiri.ng/checkout
Content-Type: application/json
```

```json
{
  "app_id": "com.kiri.example",
  "product_id": "lifetime",
  "email": "buyer@example.com",
  "name": "Buyer"
}
```

`app_id` must be a stable identifier for the app. Use the same identifier for restore and status calls. Do not use a temporary installation ID.

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

The app should save `recovery_id` immediately and show a copy button, QR code, or export action. The recovery ID is the user's way to restore after clearing app data.

## 3. Restore after reinstall or data wipe

```http
POST https://license.kiri.ng/restore
Content-Type: application/json
```

```json
{
  "recovery_id": "KIRI-L-...",
  "app_id": "com.kiri.example"
}
```

An active response includes a signed `token`. The app should store the token in its local secure storage and use it for offline checks.

The Worker returns one of these statuses:

- `active`: access is current.
- `grace`: a short configured grace period is active.
- `expired`: the paid period ended.
- `revoked`: a refund or chargeback revoked the license.

Do not unlock premium functionality from a client-provided `premium=true` flag alone. The local token is a cache; the Worker is authoritative when online.

## 4. Refresh status

```http
POST https://license.kiri.ng/status
Content-Type: application/json
```

Use the same request body as restore. Refresh when the app starts online, resumes from background, or reaches the end of its local token lifetime.

## Offline token verification

The token format is:

```text
v1.<base64url-payload>.<base64url-signature>
```

The app verifies:

- the ECDSA P-256 signature using the public key above;
- `iss` is `license.kiri.ng`;
- `app` matches the current app ID;
- `status` is `active` or `grace`;
- `exp`, when present, has not passed.

The Worker signs the token with the private key. Apps never need the private key and never need the Flutterwave Secret Key.

## Recommended app flow

```text
App starts
  -> read cached token
  -> verify token locally
  -> if online, call /status
  -> update local entitlement

User taps Unlock
  -> call /checkout
  -> open checkout_url
  -> save recovery_id
  -> call /restore or wait for webhook

User clears app data
  -> user enters recovery_id
  -> call /restore
  -> save the returned token
```

## Google Play

Google Play-distributed builds use the existing `flet-billing` package and Play Billing restore flow. Do not put an unapproved Flutterwave unlock button inside a Play-distributed app. The Worker endpoint is for direct APK, desktop, web, and other permitted external-checkout surfaces.

## Errors

- `400 invalid_request`: missing or invalid app/product/email.
- `402 payment_not_valid`: the provider amount, currency, status, or product did not match.
- `403 app_not_entitled`: the license scope does not include this app.
- `404 license_not_found`: no successful payment exists for that recovery ID.
- `429 rate_limited`: retry later.
- `502 verification_unavailable`: Flutterwave could not be reached; keep the local token during its valid period and retry online.
- `503`: deployment configuration is incomplete; check Worker Secrets, KV binding, and catalog variables.
