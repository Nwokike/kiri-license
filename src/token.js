const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importPrivateKey(secret) {
  if (!secret) throw new Error("missing private key");
  const value = String(secret).trim();
  if (value.startsWith("{")) {
    return crypto.subtle.importKey(
      "jwk",
      JSON.parse(value),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  }
  return crypto.subtle.importKey(
    "pkcs8",
    base64UrlDecode(value),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function importPublicKey(secret) {
  if (!secret) throw new Error("missing public key");
  const value = String(secret).trim();
  if (value.startsWith("{")) {
    return crypto.subtle.importKey(
      "jwk",
      JSON.parse(value),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  }
  return crypto.subtle.importKey(
    "spki",
    base64UrlDecode(value),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

export async function signEntitlement(claims, privateKey) {
  const key = await importPrivateKey(privateKey);
  const payload = base64UrlEncode(textEncoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    textEncoder.encode(payload),
  );
  return `v1.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyEntitlement(token, publicKey) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return { valid: false, payload: null };
    const key = await importPublicKey(publicKey);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlDecode(parts[2]),
      textEncoder.encode(parts[1]),
    );
    if (!valid) return { valid: false, payload: null };
    return { valid: true, payload: JSON.parse(textDecoder.decode(base64UrlDecode(parts[1]))) };
  } catch {
    return { valid: false, payload: null };
  }
}
