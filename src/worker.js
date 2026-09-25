import {
  getConfig,
  publicCatalog,
  productForCode,
  productForId,
  SERVICE_VERSION,
} from "./config.js";
import {
  allowRequest,
  isStale,
  makeRecoveryId,
  isSeen,
  markSeen,
  newRecord,
  nowMs,
  parseRecoveryId,
  putMapping,
  readRecord,
  recoveryHash,
  resolveEntHash,
  scopeAllows,
  statusFor,
  storeCheckout,
  subKey,
  txKey,
  writeRecord,
} from "./entitlements.js";
import {
  createPayment,
  eventId,
  eventName,
  FlutterwaveError,
  paymentIsSuccessful,
  paymentMatches,
  getPlan,
  listPlans,
  paymentPaidThrough,
  subscriptionByTransactionId,
  verifyById,
  verifyByReference,
  webhookSecretMatches,
} from "./flutterwave.js";
import { corsHeaders, errorResponse, htmlResponse, jsonResponse, methodNotAllowed, readJson } from "./http.js";
import { signEntitlement } from "./token.js";

function clientId(request) {
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    || "unknown";
}

function apiEnv(config, env) {
  return { ...env, FLW_API_BASE: config.flwApiBase };
}

function productFromRecovery(config, recoveryId) {
  const parsed = parseRecoveryId(recoveryId);
  return parsed ? productForCode(config, parsed.code) : null;
}

function publicError(status, code) {
  return { status, code };
}

function validateAppId(appId) {
  return typeof appId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,127}$/.test(appId);
}

function validateEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function claimsFor(record, appId, status, at = nowMs()) {
  const graceMs = Math.max(0, Number(record.graceDays || 0)) * 24 * 60 * 60 * 1000;
  const exp = record.paidThrough
    ? Math.floor((Number(record.paidThrough) + graceMs) / 1000)
    : null;
  return {
    iss: "license.kiri.ng",
    v: 1,
    ent: record.ent,
    app: appId,
    product: record.product,
    scope: record.scope,
    mode: record.kind,
    status,
    paid_through: record.paidThrough || null,
    iat: Math.floor(at / 1000),
    exp,
  };
}

async function issueEntitlement(config, record, appId, status) {
  if (!config.hasSigningKey) return null;
  return signEntitlement(claimsFor(record, appId, status), config.privateKey);
}

async function refreshSubscription(config, env, record) {
  if (record.kind !== "recurring" || record.revoked || !record.flwTransactionId) return { record, changed: false };
  if (!isStale(record)) return { record, changed: false };
  try {
    const subscription = await subscriptionByTransactionId(apiEnv(config, env), record.flwTransactionId);
    if (!subscription) return { record, changed: false };
    const next = {
      ...record,
      subscriptionStatus: String(subscription.status || "active").toLowerCase(),
      flwSubscriptionId: subscription.id == null ? record.flwSubscriptionId : String(subscription.id),
      updatedAt: nowMs(),
    };
    if (next.flwSubscriptionId && next.flwSubscriptionId !== record.flwSubscriptionId) {
      await putMapping(env.ENT, await subKey(next.flwSubscriptionId), record.ent);
    }
    return { record: next, changed: true };
  } catch {
    return { record, changed: false };
  }
}

async function recordFromVerifiedPayment(config, env, product, recoveryId, payment) {
  const hash = await recoveryHash(recoveryId);
  const record = {
    ...newRecord({ product, hash, scope: product.scope, recoveryCode: parseRecoveryId(recoveryId)?.code }),
    flwTransactionId: payment.id == null ? null : String(payment.id),
    flwRef: payment.flw_ref == null ? null : String(payment.flw_ref),
    flwSubscriptionId: payment.subscription_id == null ? null : String(payment.subscription_id),
    paidThrough: paymentPaidThrough(payment, product),
    subscriptionStatus: product.kind === "recurring" ? "active" : null,
    updatedAt: nowMs(),
  };
  if (record.flwSubscriptionId) {
    await putMapping(env.ENT, await subKey(record.flwSubscriptionId), hash);
  }
  await putMapping(env.ENT, await txKey(recoveryId), hash);
  await writeRecord(env.ENT, record);
  return record;
}

async function recoverFromProvider(config, env, recoveryId) {
  const product = productFromRecovery(config, recoveryId);
  if (!product) return { error: publicError(400, "invalid_recovery_id") };
  let payment;
  try {
    payment = await verifyByReference(apiEnv(config, env), recoveryId);
  } catch (error) {
    if (error instanceof FlutterwaveError && (error.status === 400 || error.status === 404)) {
      return { error: publicError(404, "license_not_found") };
    }
    return { error: publicError(502, "verification_unavailable") };
  }
  const paymentStatus = String(payment?.status || "").toLowerCase();
  if (["pending", "initiated", "requires_action"].includes(paymentStatus)) {
    return { error: publicError(202, "payment_pending") };
  }
  if (!paymentMatches(payment, product)) return { error: publicError(402, "payment_not_valid") };
  const record = await recordFromVerifiedPayment(config, env, product, recoveryId, payment);
  if (record.kind === "recurring" && !record.flwSubscriptionId && record.flwTransactionId) {
    try {
      const subscription = await subscriptionByTransactionId(apiEnv(config, env), record.flwTransactionId);
      if (subscription?.id != null) {
        record.flwSubscriptionId = String(subscription.id);
        await putMapping(env.ENT, await subKey(record.flwSubscriptionId), record.ent);
        await writeRecord(env.ENT, record);
      }
    } catch {
      // The initial transaction is still valid; a later webhook can add the
      // subscription pointer when Flutterwave provides it.
    }
  }
  return { record };
}

async function handleCheckout(request, config, env) {
  if (!config.hasCatalog) return errorResponse(config, request, 503, "catalog_not_configured", { publicRoute: true });
  if (!config.hasFlutterwave) return errorResponse(config, request, 503, "payments_not_configured");
  if (!env.ENT) return errorResponse(config, request, 503, "storage_not_configured");
  const body = await readJson(request);
  if (!body || !validateAppId(body.app_id) || typeof body.product_id !== "string") {
    return errorResponse(config, request, 400, "invalid_request");
  }
  if (!validateEmail(body.email)) return errorResponse(config, request, 400, "email_required");
  const product = productForId(config, body.product_id);
  if (!product) return errorResponse(config, request, 404, "product_not_found");
  if (!product.paymentPlanId && product.kind === "recurring") {
    return errorResponse(config, request, 503, "payment_plan_not_configured");
  }
  if (!(await allowRequest(env.ENT, "checkout", clientId(request), 10, 60))) {
    return errorResponse(config, request, 429, "rate_limited");
  }
  const recoveryId = makeRecoveryId(product.code);
  const hash = await recoveryHash(recoveryId);
  await storeCheckout(env.ENT, { hash, txRef: recoveryId, product, scope: product.scope });
  try {
    const payment = await createPayment(apiEnv(config, env), {
      txRef: recoveryId,
      amount: product.amount,
      currency: product.currency,
      email: body.email,
      name: typeof body.name === "string" ? body.name.slice(0, 120) : undefined,
      phoneNumber: typeof body.phone_number === "string" ? body.phone_number.slice(0, 40) : undefined,
      redirectUrl: config.successUrl,
      paymentPlanId: product.paymentPlanId,
      meta: { app_id: body.app_id, product_id: product.id, entitlement_version: 1 },
    });
    return jsonResponse(config, request, {
      recovery_id: recoveryId,
      checkout_url: payment.link,
      product: product.id,
      status: "pending",
      amount: product.amount,
      currency: product.currency,
    }, 201);
  } catch (error) {
    const status = error instanceof FlutterwaveError && error.status >= 400 && error.status < 500 ? error.status : 502;
    const providerMessage = error instanceof FlutterwaveError
      && error.details
      && typeof error.details.message === "string"
      ? error.details.message.slice(0, 160)
      : null;
    console.error("checkout_failed", {
      status,
      providerStatus: error instanceof FlutterwaveError ? error.status : null,
      providerClass: error instanceof FlutterwaveError && error.details ? "api_response" : "network_or_timeout",
      providerMessage,
    });
    return errorResponse(config, request, status, "checkout_failed");
  }
}

async function handleRestore(request, config, env, statusOnly = false) {
  if (!config.hasCatalog) return errorResponse(config, request, 503, "catalog_not_configured");
  if (!config.hasSigningKey && !statusOnly) return errorResponse(config, request, 503, "signing_not_configured");
  if (!env.ENT) return errorResponse(config, request, 503, "storage_not_configured");
  const body = await readJson(request);
  const parsed = body ? parseRecoveryId(body.recovery_id) : null;
  if (!body || !parsed || !validateAppId(body.app_id)) return errorResponse(config, request, 400, "invalid_request");
  if (!(await allowRequest(env.ENT, "restore", clientId(request), 20, 60))) {
    return errorResponse(config, request, 429, "rate_limited");
  }
  const hash = await recoveryHash(parsed.id);
  let record = await readRecord(env.ENT, hash);
  if (!record) {
    const recovered = await recoverFromProvider(config, env, parsed.id);
    if (recovered.error) return errorResponse(config, request, recovered.error.status, recovered.error.code);
    record = recovered.record;
  } else {
    const refreshed = await refreshSubscription(config, env, record);
    record = refreshed.record;
    if (refreshed.changed) await writeRecord(env.ENT, record);
  }
  const status = statusFor(record);
  if (!scopeAllows(record, body.app_id)) return errorResponse(config, request, 403, "app_not_entitled");
  const response = {
    recovery_id: parsed.id,
    product: record.product,
    status,
    paid_through: record.paidThrough || null,
    scope: record.scope,
  };
  if (!statusOnly && (status === "active" || status === "grace")) {
    response.token = await issueEntitlement(config, record, body.app_id, status);
  }
  return jsonResponse(config, request, response);
}

function extractWebhookData(payload) {
  return payload?.data && typeof payload.data === "object" ? payload.data : {};
}

async function findWebhookRecord(config, env, payload) {
  const data = extractWebhookData(payload);
  const txRef = data.tx_ref || payload?.tx_ref;
  const subscriptionId = data.subscription_id || data.subscription?.id;
  const entHash = await resolveEntHash(env.ENT, { txRef, subscriptionId });
  if (!entHash) return null;
  return readRecord(env.ENT, entHash);
}

async function processWebhook(config, env, payload) {
  const data = extractWebhookData(payload);
  const name = eventName(payload);
  const record = await findWebhookRecord(config, env, payload);
  if (!record) return { matched: false };
  const product = productForId(config, record.product);
  if (!product) return { matched: true, updated: false };
  const at = nowMs();

  if (name.includes("refund.completed") || name.includes("chargeback")) {
    record.revoked = true;
    record.revokedAt = at;
    record.updatedAt = at;
    await writeRecord(env.ENT, record);
    return { matched: true, updated: true, status: "revoked" };
  }

  if (name.includes("subscription.cancelled")) {
    record.subscriptionStatus = "cancelled";
    record.updatedAt = at;
    await writeRecord(env.ENT, record);
    return { matched: true, updated: true, status: "cancelled" };
  }

  if (name.includes("charge.completed") || name.includes("charge")) {
    let payment = data;
    if (!paymentIsSuccessful(payment) || !paymentMatches(payment, product)) {
      try {
        payment = data.id && !String(data.id).startsWith("KIRI-")
          ? await verifyById(apiEnv(config, env), data.id)
          : await verifyByReference(apiEnv(config, env), data.tx_ref);
      } catch {
        return { matched: true, updated: false, retry: true };
      }
    }
    if (!paymentMatches(payment, product)) return { matched: true, updated: false, retry: true };
    record.paidThrough = paymentPaidThrough(payment, product, at);
    record.subscriptionStatus = product.kind === "recurring" ? "active" : null;
    record.flwTransactionId = payment.id == null ? record.flwTransactionId : String(payment.id);
    record.flwRef = payment.flw_ref == null ? record.flwRef : String(payment.flw_ref);
    const subscriptionId = data.subscription_id || data.subscription?.id || payment.subscription_id;
    if (subscriptionId != null) {
      record.flwSubscriptionId = String(subscriptionId);
      await putMapping(env.ENT, await subKey(record.flwSubscriptionId), record.ent);
    }
    record.updatedAt = at;
    await writeRecord(env.ENT, record);
    return { matched: true, updated: true, status: "active" };
  }

  return { matched: true, updated: false };
}

async function handleWebhook(request, config, env) {
  const raw = await request.text();
  const received = request.headers.get("verif-hash") || request.headers.get("x-verif-hash");
  if (!config.hasWebhook || !webhookSecretMatches(config.webhookHash, received)) {
    return jsonResponse(config, request, { error: "invalid_webhook_signature" }, 401);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return jsonResponse(config, request, { error: "invalid_json" }, 400);
  }
  const id = eventId(payload, raw);
  if (await isSeen(env.ENT, id)) return jsonResponse(config, request, { status: "already_processed" });
  try {
    const result = await processWebhook(config, env, payload);
    if (result.retry) return jsonResponse(config, request, { status: "retry" }, 503);
    await markSeen(env.ENT, id);
    return jsonResponse(config, request, { status: "accepted", matched: result.matched });
  } catch {
    return jsonResponse(config, request, { status: "retry" }, 503);
  }
}

function handleHealth(config) {
  return {
    status: "ok",
    service: "kiri-license",
    version: SERVICE_VERSION,
    configured: {
      catalog: config.hasCatalog,
      payments: config.hasFlutterwave,
      webhook: config.hasWebhook,
      signing: config.hasSigningKey,
      storage: false,
    },
  };
}

export default {
  async fetch(request, env = {}, _ctx) {
    const config = getConfig(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    const method = request.method.toUpperCase();

    try {
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(config, request, false) });
      }
      if (method === "GET" && path === "/plan-check") {
        // Diagnostic: the hosted checkout reports "Payment plan does not
        // exist" without an error code, so ask the API directly with the
        // same secret key the charge is created with.
        const product = new URL(request.url).searchParams.get("product") || "monthly";
        const catalogProduct = productForId(config, product);
        if (!catalogProduct) {
          return jsonResponse(config, request, { product, note: "unknown product" }, 404, { publicRoute: true });
        }
        if (!catalogProduct.paymentPlanId) {
          return jsonResponse(config, request, { product, planId: null, note: "no plan configured (one-time charge)" }, 200, { publicRoute: true });
        }
        const plan = await getPlan(env, catalogProduct.paymentPlanId);
        if (plan.resolved === false) {
          const visible = await listPlans(env);
          return jsonResponse(config, request, { product, ...plan, visiblePlans: visible }, 200, { publicRoute: true });
        }
        return jsonResponse(config, request, { product, ...plan }, 200, { publicRoute: true });
      }
      if (method === "GET" && path === "/health") {
        const body = handleHealth(config);
        body.configured.storage = Boolean(env.ENT);
        return jsonResponse(config, request, body, 200, { publicRoute: true });
      }
      if (method === "GET" && path === "/catalog") {
        return jsonResponse(config, request, { products: publicCatalog(config) }, 200, { publicRoute: true });
      }
      if (method === "GET" && path === "/success") {
        return htmlResponse(config, request, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kiri payment received</title></head><body><main><h1>Payment received</h1><p>Return to the Kiri app to finish restoring your license.</p></main></body></html>`, { publicRoute: true });
      }
      if (path === "/checkout" || path === "/v1/checkout") {
        if (method !== "POST") return methodNotAllowed(config, request, ["POST"]);
        return handleCheckout(request, config, env);
      }
      if (path === "/restore" || path === "/v1/restore") {
        if (method !== "POST") return methodNotAllowed(config, request, ["POST"]);
        return handleRestore(request, config, env, false);
      }
      if (path === "/status" || path === "/v1/status") {
        if (method !== "POST") return methodNotAllowed(config, request, ["POST"]);
        return handleRestore(request, config, env, true);
      }
      if (path === "/webhook" || path === "/v1/webhook") {
        if (method !== "POST") return methodNotAllowed(config, request, ["POST"]);
        return handleWebhook(request, config, env);
      }
      return errorResponse(config, request, 404, "not_found", { publicRoute: true });
    } catch {
      return errorResponse(config, request, 500, "internal_error");
    }
  },
};
