import { webcrypto } from "node:crypto";
import { base64UrlEncode } from "../src/token.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));

console.log("Add the private value as the Cloudflare secret LICENSE_PRIVATE_KEY:");
console.log(base64UrlEncode(privateKey));
console.log("\nAdd the public value as LICENSE_PUBLIC_KEY:");
console.log(base64UrlEncode(publicKey));
console.log("\nDo not commit either value.");
