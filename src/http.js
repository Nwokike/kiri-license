import { originAllowed } from "./config.js";

export function corsHeaders(config, request, publicRoute = false) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (originAllowed(config, origin, publicRoute)) {
    headers["Access-Control-Allow-Origin"] = publicRoute && !config.allowedOrigins.length ? "*" : origin || "*";
  }
  return headers;
}

export function jsonResponse(config, request, data, status = 200, options = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(config, request, options.publicRoute),
    ...(options.headers || {}),
  };
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

export function errorResponse(config, request, status, code, options = {}) {
  return jsonResponse(config, request, { error: code }, status, options);
}

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

export function withPublicCache(response, seconds = 60) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${seconds}`);
  return new Response(response.body, { status: response.status, headers });
}

export function methodNotAllowed(config, request, methods) {
  return errorResponse(config, request, 405, "method_not_allowed", {
    headers: { Allow: methods.join(", ") },
  });
}
