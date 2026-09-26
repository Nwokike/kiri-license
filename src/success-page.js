// The post-checkout return page (GET /success).
//
// Flutterwave redirects here with ?status=&tx_ref=&transaction_id= appended
// (their Standard flow documents exactly those params). The checkout also
// carries the caller's app in the URL fragment (#app_id=…) — fragments never
// reach the server, so the inline script reads it; the server-side render
// needs only status + tx_ref.
//
// This page is shared by EVERY app that bills through this Worker: product
// names come from the catalog, copy stays app-neutral ("the app").

import { productForCode } from "./config.js";
import { parseRecoveryId } from "./entitlements.js";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function productLabel(config, recoveryId) {
  const parsed = parseRecoveryId(recoveryId);
  if (!parsed) return "";
  const product = productForCode(config, parsed.code);
  if (!product) return "";
  return String(product.id).replace(/(^|[_-])([a-z])/g, (m, sep, letter) => `${sep ? " " : ""}${letter.toUpperCase()}`);
}

export function renderSuccessPage(config, { status = "", txRef = "" } = {}) {
  const parsed = parseRecoveryId(txRef);
  const recoveryId = parsed ? parsed.id : "";
  const label = productLabel(config, recoveryId);
  const mode = status === "successful" ? "verify" : (status ? "failed" : "neutral");

  const idBlock = recoveryId
    ? [
      "<div class=\"idcard\">",
      "<div class=\"cap\">YOUR RECOVERY ID — THIS IS YOUR LICENSE KEY</div>",
      `<code id=\"recovery\" class=\"rid\">${escapeHtml(recoveryId)}</code>`,
      "<button id=\"copy\" type=\"button\">Copy</button>",
      "</div>",
      `<p class=\"muted\">${escapeHtml(label)} license. Save this email/link — the ID restores your license on any device.</p>`,
    ].join("")
    : "<p class=\"muted\">No payment reference found in this link.</p>";

  let panel = "";
  if (mode === "verify") {
    panel = [
      "<div id=\"check\" class=\"panel\">",
      "<div class=\"row\"><span class=\"dot pulse\"></span><span id=\"check-text\">Confirming your payment…</span></div>",
      "<div id=\"check-done\" class=\"done\" hidden></div>",
      "</div>",
    ].join("");
  } else if (mode === "failed") {
    panel = [
      "<div class=\"panel bad\">",
      `<strong>Payment not completed</strong><p>Flutterwave reported this payment as <em>${escapeHtml(status)}</em>. No license was issued — go back to the app and start the purchase again.</p>`,
      "</div>",
    ].join("");
  } else {
    panel = [
      "<div class=\"panel\">",
      "<strong>Waiting for your payment</strong><p>Finish paying in the checkout tab, then come back — or just return to the app: it finishes activation by itself.</p>",
      "</div>",
    ].join("");
  }

  // Page-side script deliberately avoids template literals so it can live
  // inside this builder's own template string.
  const script = mode === "verify" && recoveryId ? `
<script>
(function () {
  var id = ${JSON.stringify(recoveryId)};
  var hash = location.hash.replace(/^#/, "");
  var appId = new URLSearchParams(hash).get("app_id") || "unknown";
  var attempt = 0;
  var textEl = document.getElementById("check-text");
  var doneEl = document.getElementById("check-done");
  var copyBtn = document.getElementById("copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var value = id;
      function ok() { copyBtn.textContent = "Copied"; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(ok, fallback);
      } else { fallback(); }
      function fallback() {
        var range = document.createRange();
        var node = document.getElementById("recovery");
        if (!node) return;
        range.selectNode(node);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        try { document.execCommand("copy"); ok(); } catch (e) {}
      }
    });
  }
  function finish(kind, data) {
    var active = kind === "active";
    document.querySelector("#check .dot").className = "dot " + (active ? "ok" : "warn");
    textEl.hidden = true;
    doneEl.hidden = false;
    if (active) {
      var until = data && data.paid_through
        ? " — active through " + new Date(data.paid_through).toISOString().slice(0, 10)
        : "";
      doneEl.innerHTML = "<strong>License confirmed" + until + "</strong><p>Open the app: it unlocks automatically. No further steps.</p>";
    } else if (kind === "scope") {
      doneEl.innerHTML = "<strong>This license belongs to another app</strong><p>Open the app you bought it in — or use Restore purchases with the ID above.</p>";
    } else {
      doneEl.innerHTML = "<strong>Still processing</strong><p>Flutterwave is confirming the charge. Return to the app — it finishes itself once the check lands. If nothing happens after a minute, tap Restore purchases and paste the ID above.</p>";
    }
  }
  function check() {
    attempt += 1;
    fetch("/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recovery_id: id, app_id: appId })
    }).then(function (res) {
      if (res.status === 403) { finish("scope"); return null; }
      return res.json().catch(function () { return null; }).then(function (data) {
        var st = data && data.status;
        if (st === "active" || st === "grace") { finish("active", data); return; }
        if (attempt >= 4) { finish("slow"); return; }
        setTimeout(check, 3000);
      });
    }).catch(function () {
      if (attempt >= 4) { finish("slow"); return; }
      setTimeout(check, 3000);
    });
  }
  setTimeout(check, 0);
})();
</script>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>Kiri payment</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px; background: #f4f6fa; color: #1c2430;
         font-family: Arial, Helvetica, sans-serif; }
  main { max-width: 520px; margin: 0 auto; }
  .brand { display: block; height: 56px; width: auto; margin: 0 0 12px; }
  h1 { font-size: 22px; margin: 8px 0 4px; }
  .sub { color: #5b6675; margin: 0 0 20px; }
  .panel { background: #ffffff; border: 1px solid #e3e8f0; border-radius: 12px;
           padding: 18px; margin-bottom: 16px; }
  .panel.bad { border-color: #d7737d; }
  .panel p { margin: 8px 0 0; color: #5b6675; font-size: 14px; line-height: 1.5; }
  .idcard { background: #f0f3f8; border: 1px dashed #c7d0dd; border-radius: 8px;
            padding: 16px; text-align: center; margin-bottom: 8px; }
  .cap { font-size: 11px; color: #5b6675; margin-bottom: 8px; letter-spacing: .04em; }
  .rid { display: block; font-size: 16px; color: #1a7f37; letter-spacing: 1px;
         word-break: break-all; margin-bottom: 12px; }
  button { background: #1f6feb; color: #fff; border: 0; border-radius: 6px;
           padding: 8px 18px; font-size: 14px; cursor: pointer; }
  button:hover { background: #2a76f5; }
  .muted { color: #5b6675; font-size: 13px; }
  .row { display: flex; align-items: center; gap: 10px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #d29922; flex: none; }
  .dot.ok { background: #2ea043; }
  .dot.warn { background: #d29922; }
  .dot.pulse { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .3; } }
  .done strong { display: block; margin-bottom: 6px; }
  .done p { margin: 0; color: #5b6675; font-size: 14px; line-height: 1.5; }
  .foot { color: #6b7280; font-size: 12px; margin-top: 20px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e7e9ee; }
    .sub { color: #9aa3b2; }
    .panel { background: #171a21; border-color: #262b36; }
    .panel.bad { border-color: #6e2b32; }
    .panel p { color: #9aa3b2; }
    .idcard { background: #0f1115; border-color: #3d4657; }
    .cap { color: #9aa3b2; }
    .rid { color: #7ee787; }
    .muted { color: #9aa3b2; }
    .done p { color: #9aa3b2; }
  }
</style>
</head>
<body>
<main>
  <img class="brand" src="https://kiri.ng/static/images/logos/logo.webp"
       onerror="this.src='https://kiri.ng/static/images/logos/logo.png'"
       alt="Kiri Research Labs" height="56">
  <h1>Payment received</h1>
  <p class="sub">Kiri Research Labs — secure checkout</p>
  ${panel}
  ${idBlock}
  <p class="muted">Open the app to finish — it detects your payment automatically.</p>
  <p class="foot">Questions? Reply to your receipt email or contact support@kiri.ng.</p>
</main>
${script}
</body>
</html>`;
}
