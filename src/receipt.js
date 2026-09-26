// Kiri license receipt — sent by this Worker for EVERY app that bills
// through it (KTV Player, CollabShell, Sherlock, …). Deliberately generic:
// no app names, only the license facts the payer needs to recover their
// purchase. Delivered over Brevo SMTP (same credentials as igbo-archives),
// From is a replyable human address.
//
// Fail-open by contract: a missing/placeholder key or a transport error logs
// and returns false — it must never break /restore or the webhook.

import { sendSmtp } from "./smtp.js";

export const RECEIPT_FROM = "Kiri Research Labs";
export const RECEIPT_FROM_ADDRESS = "support@kiri.ng";
// Public asset on the Cloudflare Pages site (kiri-static repo → kiri.ng).
// PNG for email (universal client support); the mark has a white outline so
// it reads on both light and dark palettes.
export const LOGO_URL = "https://kiri.ng/static/images/logos/logo.png";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatDate(ms) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function renewalLine(product) {
  if (product.kind === "recurring") {
    const interval = product.interval || "monthly";
    return `Your <strong>${escapeHtml(product.id)}</strong> license renews automatically every ${escapeHtml(interval)}. `
      + "Flutterwave emails you before each renewal with a cancel link — cancelling keeps the license until the date below.";
  }
  return "This is a one-time payment — it never renews.";
}

/**
 * Build the exact email for a (renewal) payment on a recovery ID.
 * Returns { to, headers, html, text }.
 */
export function receiptMessage({ to, product, recoveryId, paidThrough }) {
  const label = String(product.id || "license").replace(/(^|[_-])([a-z])/g, (m, sep, letter) => `${sep ? " " : ""}${letter.toUpperCase()}`);
  const subject = `Your Kiri license receipt — ${label}`;
  const paidThroughLine = paidThrough
    ? `Paid through: <strong>${formatDate(paidThrough)}</strong>`
    : "Paid through: your receipt shows the provider's confirmation.";
  const html = [
    "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\">",
    "<style>",
    // Light is the inline default (works in every client, Outlook included);
    // clients that understand prefers-color-scheme flip to the dark palette
    // via !important, which is the only thing that beats an inline style.
    "@media (prefers-color-scheme: dark) {",
    "  .k-page { background: #0f1115 !important; }",
    "  .k-card { background: #171a21 !important; border-color: #262b36 !important; }",
    "  .k-h1 { color: #e7e9ee !important; }",
    "  .k-text { color: #c9d1dc !important; }",
    "  .k-idbox { background: #0f1115 !important; border-color: #3d4657 !important; }",
    "  .k-cap { color: #9aa3b2 !important; }",
    "  .k-rid { color: #7ee787 !important; }",
    "  .k-foot { color: #6b7280 !important; }",
    "}",
    "</style></head>",
    "<body class=\"k-page\" style=\"margin:0;padding:24px;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#1c2430;\">",
    "<div class=\"k-card\" style=\"max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e8f0;border-radius:12px;padding:28px;\">",
    `<img src=\"${LOGO_URL}\" alt=\"Kiri Research Labs\" width=\"170\" style=\"display:block;border:0;width:170px;height:auto;margin:0 0 18px;\">`,
    "<h1 class=\"k-h1\" style=\"margin:0 0 4px;font-size:20px;color:#1c2430;\">Payment received</h1>",
    `<p class="k-text" style="margin:0 0 20px;color:#5b6675;">Kiri Research Labs — license receipt</p>`,
    `<p class="k-text" style="margin:0 0 16px;color:#1c2430;">${escapeHtml(label)} license — <strong>${escapeHtml(product.currency)} ${escapeHtml(product.amount)}</strong></p>`,
    `<p class="k-text" style="margin:0 0 16px;color:#1c2430;">${paidThroughLine}</p>`,
    `<p class="k-text" style="margin:0 0 8px;color:#1c2430;">${renewalLine(product)}</p>`,
    "<div class=\"k-idbox\" style=\"margin:20px 0;padding:16px;background:#f0f3f8;border:1px dashed #c7d0dd;border-radius:8px;text-align:center;\">",
    `<div class="k-cap" style="font-size:12px;color:#5b6675;margin-bottom:6px;letter-spacing:.04em;">YOUR RECOVERY ID — KEEP THIS EMAIL</div>`,
    `<code class="k-rid" style="font-size:16px;letter-spacing:1px;color:#1a7f37;">${escapeHtml(recoveryId)}</code>`,
    "</div>",
    "<p class=\"k-text\" style=\"margin:0 0 12px;color:#1c2430;\">The app finishes activating by itself when you return to it after paying — no extra steps.</p>",
    "<p class=\"k-text\" style=\"margin:0;color:#5b6675;\">On a new device or after a reinstall, open the app → Settings → Restore purchases and enter the recovery ID above. It is also stored on the device you paid from.</p>",
    "</div>",
    "<div class=\"k-foot\" style=\"max-width:520px;margin:12px auto 0;font-size:12px;color:#6b7280;\">Kiri Research Labs · reply to this email any time · you are receiving it because a payment was made with your address.</div>",
    "</body></html>",
  ].join("");
  const text = [
    "Payment received — Kiri Research Labs license receipt",
    "",
    `${label} license — ${product.currency} ${product.amount}`,
    paidThrough ? `Paid through: ${formatDate(paidThrough)}` : "",
    "",
    `Recovery ID: ${recoveryId}`,
    "",
    "The app finishes activating by itself when you return to it.",
    "On a new device: Settings → Restore purchases, enter the recovery ID.",
    product.kind === "recurring"
      ? `Renews automatically every ${product.interval || "monthly"}; Flutterwave's reminder email has the cancel link.`
      : "One-time payment — never renews.",
  ].filter(Boolean).join("\r\n");
  const headers = [
    `From: ${RECEIPT_FROM} <${RECEIPT_FROM_ADDRESS}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
  ].join("\r\n");
  return { to, headers, html, text };
}

/**
 * Send one receipt. Returns true when the transport accepted it, false when
 * skipped or failed (logged either way — never throws).
 *
 * env needs BREVO_EMAIL_USER (SMTP login) and BREVO_SMTP_KEY (secret; a
 * REPLACE-placeholder means "not set yet" and skips cleanly).
 */
export async function sendReceipt(env, message, deps = {}) {
  const user = typeof env.BREVO_EMAIL_USER === "string" ? env.BREVO_EMAIL_USER : "";
  const pass = typeof env.BREVO_SMTP_KEY === "string" ? env.BREVO_SMTP_KEY : "";
  if (!user || !pass) {
    console.info("receipt_skipped", { reason: "smtp_not_configured" });
    return false;
  }
  if (pass.startsWith("REPLACE")) {
    console.info("receipt_skipped", { reason: "placeholder_smtp_key" });
    return false;
  }
  try {
    const mail = receiptMessage(message);
    await sendSmtp(
      {
        host: "smtp-relay.brevo.com",
        port: 587,
        user,
        pass,
        from: RECEIPT_FROM_ADDRESS,
        to: mail.to,
        headers: mail.headers,
        html: mail.html,
      },
      deps,
    );
    console.log("receipt_sent", { to: mail.to, recovery_id: message.recoveryId });
    return true;
  } catch (error) {
    console.error("receipt_send_failed", { message: String((error && error.message) || error) });
    return false;
  }
}
