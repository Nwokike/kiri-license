const DEFAULT_TIMEOUT_MS = 10_000;

export class FlutterwaveError extends Error {
  constructor(message, status = 502, details = null) {
    super(message);
    this.name = "FlutterwaveError";
    this.status = status;
    this.details = details;
  }
}

function authHeaders(secret) {
  if (!secret) throw new FlutterwaveError("Flutterwave is not configured", 503);
  return { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
}

async function requestJson(url, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    if (!response.ok) {
      throw new FlutterwaveError("Flutterwave request failed", response.status, body);
    }
    return body;
  } catch (error) {
    if (error instanceof FlutterwaveError) throw error;
    if (error?.name === "AbortError") throw new FlutterwaveError("Flutterwave request timed out", 504);
    throw new FlutterwaveError("Flutterwave request failed", 502, null);
  } finally {
    clearTimeout(timeout);
  }
}

export async function createPayment(env, input) {
  const body = {
    tx_ref: input.txRef,
    amount: input.amount,
    currency: input.currency,
    redirect_url: input.redirectUrl,
    customer: { email: input.email },
    customizations: { title: "Kiri" },
    meta: input.meta || {},
  };
  if (input.name) body.customer.name = input.name;
  if (input.phoneNumber) body.customer.phonenumber = input.phoneNumber;
  if (input.paymentPlanId) {
    // Flutterwave's `payment_plan` is an integer ID. Sending the config
    // string verbatim leaves the hosted page unable to resolve the plan
    // ("Payment plan does not exist") even though the charge was created.
    const planId = Number(String(input.paymentPlanId).trim());
    if (Number.isInteger(planId) && planId > 0) body.payment_plan = planId;
  }
  const response = await requestJson(`${env.FLW_API_BASE || "https://api.flutterwave.com/v3"}/payments`, {
    method: "POST",
    headers: authHeaders(env.FLW_SECRET_KEY),
    body: JSON.stringify(body),
  });
  const data = response?.data;
  if (!data?.link) throw new FlutterwaveError("Flutterwave returned no checkout link", 502, response);
  return {
    link: data.link,
    id: data.id == null ? null : String(data.id),
    txRef: data.tx_ref || input.txRef,
    raw: data,
  };
}

export async function verifyByReference(env, txRef) {
  const url = new URL(`${env.FLW_API_BASE || "https://api.flutterwave.com/v3"}/transactions/verify_by_reference`);
  url.searchParams.set("tx_ref", txRef);
  const response = await requestJson(url.toString(), { method: "GET", headers: authHeaders(env.FLW_SECRET_KEY) });
  if (!response?.data) throw new FlutterwaveError("Flutterwave returned no transaction", 502, response);
  return response.data;
}

export async function verifyById(env, id) {
  const response = await requestJson(`${env.FLW_API_BASE || "https://api.flutterwave.com/v3"}/transactions/${encodeURIComponent(id)}/verify`, {
    method: "GET",
    headers: authHeaders(env.FLW_SECRET_KEY),
  });
  if (!response?.data) throw new FlutterwaveError("Flutterwave returned no transaction", 502, response);
  return response.data;
}

export async function subscriptionByTransactionId(env, transactionId) {
  const url = new URL(`${env.FLW_API_BASE || "https://api.flutterwave.com/v3"}/subscriptions`);
  url.searchParams.set("transaction_id", String(transactionId));
  const response = await requestJson(url.toString(), { method: "GET", headers: authHeaders(env.FLW_SECRET_KEY) });
  const entries = Array.isArray(response?.data) ? response.data : [];
  return entries[0] || null;
}

export function paymentIsSuccessful(payment) {
  return String(payment?.status || "").toLowerCase() === "successful";
}

export function paymentMatches(payment, product) {
  if (!paymentIsSuccessful(payment)) return false;
  const amount = Number(payment.amount);
  const expected = Number(product.amount);
  const currency = String(payment.currency || "").toUpperCase();
  return Number.isFinite(amount) && Number.isFinite(expected)
    && Math.abs(amount - expected) < 0.000001
    && currency === String(product.currency).toUpperCase();
}

export function webhookSecretMatches(expected, received) {
  if (!expected || !received) return false;
  const left = String(expected);
  const right = String(received);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function eventName(payload) {
  return String(payload?.event || payload?.event_name || payload?.data?.event || "").toLowerCase();
}

export function eventId(payload, body) {
  const id = payload?.id || payload?.data?.id || payload?.event_id;
  if (id) return String(id);
  let hash = 2166136261;
  for (const char of String(body || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function paymentPaidThrough(payment, product, now = Date.now()) {
  if (product.kind === "one_time") return 0;
  const candidate = payment?.paid_until || payment?.period_end || payment?.next_payment_date;
  if (candidate) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (product.interval === "monthly") return now + 30 * 24 * 60 * 60 * 1000;
  if (product.interval === "yearly") return now + 365 * 24 * 60 * 60 * 1000;
  return now;
}
