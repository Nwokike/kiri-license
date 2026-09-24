import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { default: worker } = await import("../src/worker.js");
const { base64UrlEncode, verifyEntitlement } = await import("../src/token.js");

class MockKV {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value, options = {}) {
    this.values.set(key, String(value));
    if (options.expirationTtl) this.values.set(`${key}:ttl`, String(options.expirationTtl));
  }

  async delete(key) {
    this.values.delete(key);
  }
}

function request(path, init = {}) {
  return new Request(`https://license.kiri.ng${path}`, init);
}

async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: base64UrlEncode(privateBytes), publicKey: base64UrlEncode(publicBytes) };
}

const catalog = {
  monthly: {
    code: "M",
    kind: "recurring",
    interval: "monthly",
    amount: 1000,
    currency: "USD",
    paymentPlanId: 77,
    scope: "universal",
    description: "Monthly access",
  },
  yearly: {
    code: "Y",
    kind: "recurring",
    interval: "yearly",
    amount: 10000,
    currency: "USD",
    paymentPlanId: 78,
    scope: "universal",
    description: "Yearly access",
  },
  lifetime: {
    code: "L",
    kind: "one_time",
    amount: 50000,
    currency: "USD",
    paymentPlanId: null,
    scope: "universal",
    description: "Lifetime access",
  },
};

async function setup() {
  const keys = await makeKeyPair();
  const kv = new MockKV();
  const env = {
    ENT: kv,
    CATALOG_JSON: JSON.stringify(catalog),
    FLW_SECRET_KEY: "flwsect_test",
    FLW_WEBHOOK_HASH: "hook-secret",
    LICENSE_PRIVATE_KEY: keys.privateKey,
    LICENSE_PUBLIC_KEY: keys.publicKey,
    ALLOWED_ORIGINS: "*",
    SUCCESS_URL: "https://license.kiri.ng/success",
    GRACE_DAYS: 3,
  };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/payments") && init.method === "POST") {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ status: "success", message: "Hosted Link", data: { link: `https://checkout.test/${body.tx_ref}`, tx_ref: body.tx_ref } }), { status: 200 });
    }
    if (url.includes("/transactions/verify_by_reference")) {
      const ref = new URL(url).searchParams.get("tx_ref");
      const code = ref?.split("-")[1] || "L";
      const product = code === "M" ? catalog.monthly : code === "Y" ? catalog.yearly : catalog.lifetime;
      return new Response(JSON.stringify({ data: { id: 1001, tx_ref: ref, status: "successful", amount: product.amount, currency: product.currency, flw_ref: "flw-ref-1", subscription_id: product.kind === "recurring" ? 9001 : null } }), { status: 200 });
    }
    if (url.includes("/subscriptions")) {
      return new Response(JSON.stringify({ data: [{ id: 9001, status: "active", plan: 77 }] }), { status: 200 });
    }
    if (url.includes("/transactions/1001/verify")) {
      return new Response(JSON.stringify({ data: { id: 1001, tx_ref: "KIRI-M-abcdefghijklmnopqrstuvwxyz", status: "successful", amount: 1000, currency: "USD", flw_ref: "flw-ref-1" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not mocked" }), { status: 404 });
  };
  return { env, kv, keys, calls, restore: () => { globalThis.fetch = originalFetch; } };
}

async function checkout(env, product = "lifetime") {
  return worker.fetch(request("/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.test" },
    body: JSON.stringify({ app_id: "com.example.app", product_id: product, email: "buyer@example.com" }),
  }), env, { waitUntil() {} });
}

test("health and catalog are public and never expose secrets", async () => {
  const { env, restore } = await setup();
  try {
    const health = await worker.fetch(request("/health"), env, { waitUntil() {} });
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.configured.payments, true);
    assert.equal(JSON.stringify(healthBody).includes("flwsect_test"), false);

    const catalogResponse = await worker.fetch(request("/catalog", { headers: { Origin: "https://app.test" } }), env, { waitUntil() {} });
    const body = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200);
    assert.deepEqual(body.products.map((p) => p.id), ["monthly", "yearly", "lifetime"]);
    assert.equal(body.products[0].paymentPlanId, undefined);
  } finally {
    restore();
  }
});

test("checkout creates a high-entropy recovery ID without exposing the secret", async () => {
  const { env, calls, restore } = await setup();
  try {
    const response = await checkout(env, "lifetime");
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.match(body.recovery_id, /^KIRI-L-[A-Z0-9_-]{20,}$/);
    assert.equal(body.checkout_url.startsWith("https://checkout.test/"), true);
    assert.equal(calls[0].url.endsWith("/payments"), true);
    assert.equal(calls[0].init.headers.Authorization, "Bearer flwsect_test");
    assert.equal(JSON.stringify(body).includes("flwsect_test"), false);
  } finally {
    restore();
  }
});

test("restore verifies a lifetime payment and returns a valid signed token", async () => {
  const { env, keys, restore } = await setup();
  try {
    const checkoutResponse = await checkout(env, "lifetime");
    const checkoutBody = await checkoutResponse.json();
    const response = await worker.fetch(request("/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recovery_id: checkoutBody.recovery_id, app_id: "com.example.app" }),
    }), env, { waitUntil() {} });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "active");
    assert.equal(body.product, "lifetime");
    assert.equal(body.paid_through, null);
    const verified = await verifyEntitlement(body.token, keys.publicKey);
    assert.equal(verified.valid, true);
    assert.equal(verified.payload.product, "lifetime");
    assert.equal(verified.payload.app, "com.example.app");
  } finally {
    restore();
  }
});

test("restore rejects a payment with the wrong amount", async () => {
  const { env, restore } = await setup();
  try {
    const checkoutResponse = await checkout(env, "lifetime");
    const recovery = (await checkoutResponse.json()).recovery_id;
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("verify_by_reference")) {
        return new Response(JSON.stringify({ data: { id: 1, tx_ref: recovery, status: "successful", amount: 1, currency: "USD" } }), { status: 200 });
      }
      return original(input, init);
    };
    const response = await worker.fetch(request("/restore", {
      method: "POST",
      body: JSON.stringify({ recovery_id: recovery, app_id: "com.example.app" }),
    }), env, { waitUntil() {} });
    assert.equal(response.status, 402);
    assert.equal((await response.json()).error, "payment_not_valid");
    globalThis.fetch = original;
  } finally {
    restore();
  }
});

test("webhook rejects a bad hash and deduplicates a refund event", async () => {
  const { env, restore } = await setup();
  try {
    const checkoutResponse = await checkout(env, "lifetime");
    const recovery = (await checkoutResponse.json()).recovery_id;
    const restoreResponse = await worker.fetch(request("/restore", {
      method: "POST",
      body: JSON.stringify({ recovery_id: recovery, app_id: "com.example.app" }),
    }), env, { waitUntil() {} });
    assert.equal(restoreResponse.status, 200);

    const bad = await worker.fetch(request("/webhook", {
      method: "POST",
      headers: { "verif-hash": "wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ event: "refund.completed", data: { id: 1, tx_ref: recovery } }),
    }), env, { waitUntil() {} });
    assert.equal(bad.status, 401);

    const payload = { id: "evt-1", event: "refund.completed", data: { id: 1, tx_ref: recovery } };
    const good = await worker.fetch(request("/webhook", {
      method: "POST",
      headers: { "verif-hash": "hook-secret", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }), env, { waitUntil() {} });
    assert.equal(good.status, 200);
    const duplicate = await worker.fetch(request("/webhook", {
      method: "POST",
      headers: { "verif-hash": "hook-secret", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }), env, { waitUntil() {} });
    assert.equal((await duplicate.json()).status, "already_processed");

    const status = await worker.fetch(request("/status", {
      method: "POST",
      body: JSON.stringify({ recovery_id: recovery, app_id: "com.example.app" }),
    }), env, { waitUntil() {} });
    assert.equal((await status.json()).status, "revoked");
  } finally {
    restore();
  }
});

test("app scope is enforced for per-app products", async () => {
  const { env, restore } = await setup();
  try {
    const scopedCatalog = structuredClone(catalog);
    scopedCatalog.lifetime.scope = ["com.example.app"];
    env.CATALOG_JSON = JSON.stringify(scopedCatalog);
    const checkoutResponse = await checkout(env, "lifetime");
    const recovery = (await checkoutResponse.json()).recovery_id;
    const allowed = await worker.fetch(request("/restore", {
      method: "POST",
      body: JSON.stringify({ recovery_id: recovery, app_id: "com.example.app" }),
    }), env, { waitUntil() {} });
    assert.equal(allowed.status, 200);
    const denied = await worker.fetch(request("/restore", {
      method: "POST",
      body: JSON.stringify({ recovery_id: recovery, app_id: "com.other.app" }),
    }), env, { waitUntil() {} });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "app_not_entitled");
  } finally {
    restore();
  }
});

test("recurring restore maps a subscription and webhook renewal", async () => {
  const { env, restore } = await setup();
  try {
    const checkoutResponse = await checkout(env, "monthly");
    const recovery = (await checkoutResponse.json()).recovery_id;
    const restored = await worker.fetch(request("/restore", {
      method: "POST",
      body: JSON.stringify({ recovery_id: recovery, app_id: "com.example.app" }),
    }), env, { waitUntil() {} });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).product, "monthly");

    const webhook = await worker.fetch(request("/webhook", {
      method: "POST",
      headers: { "verif-hash": "hook-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "renewal-event-1",
        event: "charge.completed",
        data: { id: 2001, subscription_id: 9001, status: "successful", amount: 1000, currency: "USD" },
      }),
    }), env, { waitUntil() {} });
    assert.equal(webhook.status, 200);
    const status = await worker.fetch(request("/status", {
      method: "POST",
      body: JSON.stringify({ recovery_id: recovery, app_id: "com.example.app" }),
    }), env, { waitUntil() {} });
    assert.equal((await status.json()).status, "active");
  } finally {
    restore();
  }
});

test("OPTIONS includes the configured CORS origin", async () => {
  const { env, restore } = await setup();
  try {
    const response = await worker.fetch(request("/restore", {
      method: "OPTIONS",
      headers: { Origin: "https://app.test" },
    }), env, { waitUntil() {} });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://app.test");
  } finally {
    restore();
  }
});

test("GET /success renders the post-checkout return page", async () => {
  const { env, restore } = await setup();
  try {
    const response = await worker.fetch(request("/success"), env, { waitUntil() {} });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Payment received/);
  } finally {
    restore();
  }
});

test("unknown routes and methods return structured errors", async () => {
  const { env, restore } = await setup();
  try {
    const missing = await worker.fetch(request("/nope"), env, { waitUntil() {} });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "not_found");
    const wrongMethod = await worker.fetch(request("/checkout"), env, { waitUntil() {} });
    assert.equal(wrongMethod.status, 405);
  } finally {
    restore();
  }
});
