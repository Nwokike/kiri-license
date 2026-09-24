import { DEFAULT_CATALOG } from "./catalog.js";

export const SERVICE_VERSION = "0.1.0";

const DEFAULT_GRACE_DAYS = 3;
const DEFAULT_API_BASE = "https://api.flutterwave.com/v3";
const DEFAULT_SUCCESS_URL = "https://license.kiri.ng/success";

function parseJsonObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function positiveNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeScope(value) {
  if (value === "universal") return "universal";
  if (Array.isArray(value)) {
    const values = value.filter((item) => typeof item === "string" && item.trim());
    return values.length ? values : "universal";
  }
  if (typeof value === "string" && value.trim()) return value;
  return "universal";
}

function normalizeProduct(id, value) {
  if (!value || typeof value !== "object") return null;
  const kind = ["recurring", "prepaid", "one_time"].includes(value.kind) ? value.kind : "one_time";
  const interval = kind === "one_time" ? null : (value.interval || "monthly");
  const amount = positiveNumber(value.amount);
  const currency = typeof value.currency === "string" ? value.currency.trim().toUpperCase() : "";
  const code = typeof value.code === "string" ? value.code.trim().toUpperCase() : "";
  if (!id || !code || !currency || !amount) return null;
  return {
    id,
    code,
    kind,
    interval,
    amount,
    currency,
    paymentPlanId: value.paymentPlanId == null || value.paymentPlanId === "" ? null : String(value.paymentPlanId),
    scope: normalizeScope(value.scope),
    graceDays: Number.isInteger(value.graceDays) && value.graceDays >= 0 ? value.graceDays : null,
    description: typeof value.description === "string" ? value.description : id,
  };
}

export function normalizeCatalog(value) {
  const source = parseJsonObject(value) || {};
  const products = {};
  for (const [id, raw] of Object.entries(source)) {
    const product = normalizeProduct(id, raw);
    if (product && !Object.values(products).some((item) => item.code === product.code)) {
      products[id] = product;
    }
  }
  return products;
}

export function getConfig(env = {}) {
  const catalog = normalizeCatalog(env.CATALOG_JSON || DEFAULT_CATALOG);
  const planOverrides = {
    monthly: env.FLW_MONTHLY_PLAN_ID,
    yearly: env.FLW_YEARLY_PLAN_ID,
  };
  for (const [id, planId] of Object.entries(planOverrides)) {
    if (catalog[id] && planId != null && String(planId).trim()) {
      catalog[id].paymentPlanId = String(planId).trim();
    }
  }
  const products = Object.values(catalog);
  const allowedOrigins = typeof env.ALLOWED_ORIGINS === "string"
    ? env.ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  const graceDays = Number.isInteger(Number(env.GRACE_DAYS)) && Number(env.GRACE_DAYS) >= 0
    ? Number(env.GRACE_DAYS)
    : DEFAULT_GRACE_DAYS;
  return {
    catalog,
    products,
    flwApiBase: typeof env.FLW_API_BASE === "string" && env.FLW_API_BASE ? env.FLW_API_BASE.replace(/\/$/, "") : DEFAULT_API_BASE,
    flwSecret: typeof env.FLW_SECRET_KEY === "string" ? env.FLW_SECRET_KEY : "",
    webhookHash: typeof env.FLW_WEBHOOK_HASH === "string" ? env.FLW_WEBHOOK_HASH : "",
    privateKey: typeof env.LICENSE_PRIVATE_KEY === "string" ? env.LICENSE_PRIVATE_KEY : "",
    publicKey: typeof env.LICENSE_PUBLIC_KEY === "string" ? env.LICENSE_PUBLIC_KEY : "",
    allowedOrigins,
    successUrl: typeof env.SUCCESS_URL === "string" && env.SUCCESS_URL ? env.SUCCESS_URL : DEFAULT_SUCCESS_URL,
    defaultScope: normalizeScope(env.DEFAULT_SCOPE),
    graceDays,
    hasCatalog: products.length > 0,
    hasFlutterwave: Boolean(env.FLW_SECRET_KEY),
    hasWebhook: Boolean(env.FLW_WEBHOOK_HASH),
    hasSigningKey: Boolean(env.LICENSE_PRIVATE_KEY),
  };
}

export function publicCatalog(config) {
  return Object.values(config.catalog).map((product) => ({
    id: product.id,
    code: product.code,
    kind: product.kind,
    interval: product.interval,
    amount: product.amount,
    currency: product.currency,
    scope: product.scope,
    description: product.description,
  }));
}

export function productForId(config, id) {
  return typeof id === "string" ? config.catalog[id] || null : null;
}

export function productForCode(config, code) {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  return config.products.find((product) => product.code === normalized) || null;
}

export function originAllowed(config, origin, publicRoute = false) {
  if (publicRoute) return true;
  if (config.allowedOrigins.includes("*")) return true;
  return Boolean(origin && config.allowedOrigins.includes(origin));
}
