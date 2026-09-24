# Deployment checklist

This is the shortest path from this repository to a live `license.kiri.ng` Worker. Do not put live keys in the repository or chat.

## 1. Create the private repository

Create the private GitHub repository, then push this project to its `main` branch. Keep the repository private unless you intentionally want to publish the Worker source.

## 2. Connect Cloudflare Git integration

1. Sign in to the Cloudflare account that owns the domain zone.
2. Open **Workers & Pages**.
3. Choose **Create** → **Connect to Git**.
4. Authorize the Cloudflare GitHub App for the private repository.
5. Select `main` as the production branch.
6. Use the plain Worker deploy path. The project contains `wrangler.toml`; if Cloudflare asks for commands, use:

```text
Build command: npm ci
Deploy command: npx wrangler deploy
```

7. Save the Worker project.

Official documentation:

- https://developers.cloudflare.com/workers/ci-cd/builds/
- https://developers.cloudflare.com/workers/wrangler/configuration/

## 3. Create the KV namespace

1. Open **Workers KV**.
2. Create a namespace named `ENT`.
3. Copy its namespace ID.
4. Add it to the Worker either in the dashboard or by uncommenting this block in `wrangler.toml` and replacing the placeholder:

```toml
[[kv_namespaces]]
binding = "ENT"
id = "REPLACE_WITH_ENT_NAMESPACE_ID"
```

The namespace ID is not a secret. The records inside it are still private.

## 4. Add Worker variables and secrets

Set these as **Secrets** under Worker → Settings → Variables and Secrets:

```text
FLW_SECRET_KEY
FLW_WEBHOOK_HASH
LICENSE_PRIVATE_KEY
```

`LICENSE_PRIVATE_KEY` is generated locally:

```bash
npm run keys
```

The command prints a private key and a matching public key. Put the private value only into `LICENSE_PRIVATE_KEY`. The public key is for the app/client to verify offline entitlements; it is not a Worker secret and does not need to be entered in Cloudflare. Never put the private value in `wrangler.toml`, an app, or GitHub.

Set these as ordinary variables:

```text
FLW_MONTHLY_PLAN_ID
FLW_YEARLY_PLAN_ID
ALLOWED_ORIGINS
SUCCESS_URL
DEFAULT_SCOPE
GRACE_DAYS
```

The source catalog already uses the selected prices: 3.99 USD monthly, 24.99 USD yearly, and 49.99 USD lifetime. `FLW_MONTHLY_PLAN_ID` and `FLW_YEARLY_PLAN_ID` are the only missing catalog values. `CATALOG_JSON` is an optional full-catalog override for advanced use.

## 5. Add the custom domain

1. Open the Worker → **Settings** → **Domains & Routes**.
2. Add the custom domain:

```text
license.kiri.ng
```

3. Confirm DNS is managed by the same Cloudflare account.

Official documentation:

- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.cloudflare.com/workers/configuration/secrets/

## 6. Configure Flutterwave Test mode

1. Sign in at https://app.flutterwave.com.
2. Open **Settings → API Keys**.
3. Copy the Test Secret Key.
4. Store it as `FLW_SECRET_KEY` in Cloudflare.
5. Create the monthly and yearly Payment Plans when using auto-renewal:

```text
Monthly: interval=monthly
Yearly: interval=yearly
Duration: leave omitted for renew-until-cancel
```

6. Put the plan IDs into `CATALOG_JSON`.
7. Open Flutterwave Webhook settings.
8. Set the webhook URL:

```text
https://license.kiri.ng/webhook
```

9. Copy the Flutterwave Secret Hash into Cloudflare as `FLW_WEBHOOK_HASH`.
10. Enable successful-charge and subscription-cancellation events. Refund and chargeback webhook delivery may require Flutterwave support to enable.

Use Test mode and the documented test cards before using Live mode.

Official documentation:

- https://developer.flutterwave.com/docs/payment-plans-1
- https://developer.flutterwave.com/docs/flutterwave-standard-1
- https://developer.flutterwave.com/docs/webhooks
- https://developer.flutterwave.com/reference/verify-transaction
- https://developer.flutterwave.com/docs/refunds

## 7. Test locally before the first push

```bash
npm install
cp .dev.vars.example .dev.vars
npm run keys
npm test
npm run check
```

Then set the generated keys and Test-mode Flutterwave values in `.dev.vars`, bind the `ENT` namespace, and run:

```bash
npm run dev
```

Test:

```text
GET  /health
GET  /catalog
POST /checkout
POST /restore
POST /status
POST /webhook with an invalid verif-hash
```

The first push to `main` should create the Cloudflare deployment. Check the Worker dashboard for logs, deployment status, and the custom-domain route.

## 8. Switch to Live mode

Only after Test mode passes:

1. Complete Flutterwave business verification.
2. Copy the Live Secret Key into Cloudflare, replacing the Test key.
3. Confirm the Live Payment Plan IDs and catalog values.
4. Confirm the Live webhook Secret Hash.
5. Make one small Live transaction.
6. Verify the signed entitlement, restore flow, renewal/cancellation, and refund behavior.

## 9. Rollback and export

Cloudflare keeps Worker versions/deployments. Roll back from the Worker → Deployments page.

Export the KV records before changing stores:

```bash
wrangler kv key list --namespace-id <ENT_NAMESPACE_ID>
wrangler kv key get "<KEY>" --namespace-id <ENT_NAMESPACE_ID>
```

The values are designed as portable JSON so a future migration does not require changing the app-facing API.

## Remaining human-only actions

The code and local tests can be completed without account access. You must personally complete or approve:

- Private GitHub repository creation and Cloudflare Git App authorization.
- KV namespace creation and binding.
- Real product prices/currency and catalog confirmation.
- Flutterwave account verification and live-key activation.
- Payment Plan creation or plan-ID confirmation.
- Webhook Secret Hash entry.
- Custom domain approval and final push/deploy.
