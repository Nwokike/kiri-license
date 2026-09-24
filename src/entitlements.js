import { base64UrlEncode } from "./token.js";

const textEncoder = new TextEncoder();
const DAY_MS = 24 * 60 * 60 * 1000;
const TEMP_TTL_SECONDS = 30 * 24 * 60 * 60;
const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const STALE_MS = 24 * 60 * 60 * 1000;

export function nowMs() {
  return Date.now();
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(String(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function recoveryHash(recoveryId) {
  return sha256Hex(String(recoveryId).trim().toUpperCase());
}

export function parseRecoveryId(value) {
  const id = typeof value === "string" ? value.trim().toUpperCase() : "";
  const match = /^KIRI-([A-Z])-([A-Z0-9_-]{20,})$/.exec(id);
  if (!match) return null;
  return { id, code: match[1] };
}

export function makeRecoveryId(code) {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `KIRI-${String(code).toUpperCase()}-${base64UrlEncode(bytes).toUpperCase()}`;
}

export function entKey(hash) {
  return `ent:${hash}`;
}

export async function txKey(txRef) {
  return `tx:${await sha256Hex(String(txRef).trim().toUpperCase())}`;
}

export async function subKey(subscriptionId) {
  return `sub:${await sha256Hex(String(subscriptionId).trim())}`;
}

export function pendingKey(hash) {
  return `pending:${hash}`;
}

export function seenKey(eventId) {
  return `seen:${eventId}`;
}

export function normalizeScope(scope) {
  if (scope === "universal") return "universal";
  if (Array.isArray(scope)) return scope.filter((item) => typeof item === "string" && item.trim());
  return scope ? [String(scope)] : [];
}

export function scopeAllows(record, appId) {
  const scope = record?.scope;
  if (scope === "universal") return true;
  return Array.isArray(scope) && scope.includes(String(appId));
}

export function statusFor(record, at = nowMs()) {
  if (!record || record.revoked) return "revoked";
  if (record.kind === "recurring" && (record.paidThrough == null || record.paidThrough === 0)) return "pending";
  if (record.kind === "one_time" || record.paidThrough == null || record.paidThrough === 0) return "active";
  const graceMs = Math.max(0, Number(record.graceDays || 0)) * 24 * 60 * 60 * 1000;
  if (at <= Number(record.paidThrough)) return "active";
  if (at <= Number(record.paidThrough) + graceMs) return "grace";
  return "expired";
}

export function isStale(record, at = nowMs()) {
  if (!record || record.kind !== "recurring") return false;
  return at - Number(record.updatedAt || 0) > STALE_MS;
}

export function newRecord({ product, hash, scope, recoveryCode, now = nowMs() }) {
  return {
    v: 1,
    ent: hash,
    product: product.id,
    code: product.code,
    kind: product.kind,
    scope: scope || product.scope || "universal",
    recoveryCode,
    paidThrough: product.kind === "one_time" ? 0 : null,
    graceDays: product.graceDays == null ? 3 : product.graceDays,
    flwTransactionId: null,
    flwRef: null,
    flwSubscriptionId: null,
    subscriptionStatus: product.kind === "recurring" ? "pending" : null,
    revoked: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function publicRecord(record, appId) {
  return {
    product: record.product,
    plan: record.product,
    scope: record.scope,
    status: statusFor(record),
    paid_through: record.paidThrough || null,
    grace_days: record.graceDays,
    token_version: record.v,
  };
}

export async function readRecord(kv, hash) {
  if (!kv) return null;
  const raw = await kv.get(entKey(hash));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeRecord(kv, record) {
  if (!kv) throw new Error("ENT binding is not configured");
  await kv.put(entKey(record.ent), JSON.stringify(record));
  return record;
}

export async function getMapping(kv, key) {
  if (!kv) return null;
  return kv.get(key);
}

export async function putMapping(kv, key, value, ttl = TEMP_TTL_SECONDS) {
  if (!kv) return;
  await kv.put(key, String(value), { expirationTtl: ttl });
}

export async function isSeen(kv, eventId) {
  if (!kv || !eventId) return false;
  return Boolean(await kv.get(seenKey(String(eventId))));
}

export async function markSeen(kv, eventId) {
  if (!kv || !eventId) return false;
  await kv.put(seenKey(String(eventId)), "1", { expirationTtl: SEEN_TTL_SECONDS });
  return true;
}

export async function storeCheckout(kv, { hash, txRef, product, scope, now = nowMs() }) {
  if (!kv) throw new Error("ENT binding is not configured");
  const pending = {
    v: 1,
    ent: hash,
    product: product.id,
    scope: scope || product.scope || "universal",
    createdAt: now,
  };
  await kv.put(pendingKey(hash), JSON.stringify(pending), { expirationTtl: TEMP_TTL_SECONDS });
  await putMapping(kv, await txKey(txRef), hash);
}

export async function readPending(kv, hash) {
  if (!kv) return null;
  const raw = await kv.get(pendingKey(hash));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function resolveEntHash(kv, { txRef, subscriptionId }) {
  if (txRef) {
    const byTx = await getMapping(kv, await txKey(txRef));
    if (byTx) return byTx;
  }
  if (subscriptionId) {
    const bySub = await getMapping(kv, await subKey(subscriptionId));
    if (bySub) return bySub;
  }
  return null;
}

export async function allowRequest(kv, bucket, identifier, limit, windowSeconds) {
  if (!kv) return true;
  const bucketId = Math.floor(nowMs() / (windowSeconds * 1000));
  const key = `rate:${bucket}:${await sha256Hex(`${identifier}:${bucketId}`)}`;
  try {
    const current = Number(await kv.get(key)) || 0;
    if (current >= limit) return false;
    await kv.put(key, String(current + 1), { expirationTtl: windowSeconds });
    return true;
  } catch {
    return true;
  }
}

export function intervalMs(product) {
  if (!product?.interval) return 0;
  const match = /^(\d+)\s+(hour|day|week|month|year)s?$/.exec(product.interval);
  if (match) {
    const count = Number(match[1]);
    const unitMs = {
      hour: 60 * 60 * 1000,
      day: DAY_MS,
      week: 7 * DAY_MS,
      month: 30 * DAY_MS,
      year: 365 * DAY_MS,
    }[match[2]];
    return count * unitMs;
  }
  return product.interval === "monthly" ? 30 * DAY_MS : product.interval === "yearly" ? 365 * DAY_MS : 0;
}
