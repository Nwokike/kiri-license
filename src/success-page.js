// The post-checkout return page (GET /success).
//
// Flutterwave appends its params by naive string concatenation:
//   redirect_url + "?status=...&tx_ref=...&transaction_id=..."
// Our redirect carries the caller's app in the fragment (#app_id=...), so
// on a real payment the params land AFTER the hash and never reach the
// server. The page therefore renders every state container server-side and
// lets the inline script resolve the truth from search AND hash combined;
// plain /success?status=... URLs (tests, direct visits) still work
// server-side without JS.
//
// Shared by every app billing through this Worker: labels come from the
// catalog, copy stays app-neutral ("the app"), punctuation stays plain.

import { productForCode } from "./config.js";
import { parseRecoveryId } from "./entitlements.js";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function capitalize(value) {
  return String(value).replace(/(^|[_-])([a-z])/g, (m, sep, letter) => `${sep ? " " : ""}${letter.toUpperCase()}`);
}

function productLabel(config, recoveryId) {
  const parsed = parseRecoveryId(recoveryId);
  if (!parsed) return "";
  const product = productForCode(config, parsed.code);
  return product ? capitalize(product.id) : "";
}

// code -> product id, so the browser can label an ID that only exists in
// the fragment. Built from the catalog; stays correct for new products.
function codeLabels(config) {
  const labels = {};
  for (const product of config.products) {
    labels[product.code] = product.id;
  }
  return labels;
}

export function renderSuccessPage(config, { status = "", txRef = "" } = {}) {
  const parsed = parseRecoveryId(txRef);
  const recoveryId = parsed ? parsed.id : "";
  const label = productLabel(config, recoveryId);
  const mode = status === "successful" ? "verify" : (status ? "failed" : "neutral");

  const idCard = [
    `<div class="idcard" id="idcard"${recoveryId ? "" : " hidden"}>`,
    "<div class=\"cap\">YOUR RECOVERY ID · KEEP THIS EMAIL.</div>",
    `<code id="recovery" class="rid">${escapeHtml(recoveryId)}</code>`,
    "<button id=\"copy\" type=\"button\">Copy</button>",
    "</div>",
    `<p class="muted" id="id-label"${label ? "" : " hidden"}>${label ? `${escapeHtml(label)} license.` : ""}</p>`,
    `<p class="muted" id="id-warn"${recoveryId ? " hidden" : ""}>No payment reference found in this link.</p>`,
  ].join("");

  const panels = [
    `<div id="panel-verify" class="panel"${mode === "verify" ? "" : " hidden"}>`,
    "<div class=\"row\"><span class=\"dot pulse\"></span><span id=\"check-text\">Confirming your payment…</span></div>",
    "<div id=\"check-done\" class=\"done\" hidden></div>",
    "</div>",
    `<div id="panel-failed" class="panel bad"${mode === "failed" ? "" : " hidden"}>`,
    "<strong>Payment not completed</strong>",
    `<p>Flutterwave reported this payment as <em>${escapeHtml(status)}</em>. No license was issued. Go back to the app and start the purchase again.</p>`,
    "</div>",
    `<div id="panel-neutral" class="panel"${mode === "neutral" ? "" : " hidden"}>`,
    "<strong>Waiting for your payment</strong>",
    "<p>Finish paying in the checkout tab, then come back. Or just return to the app: it finishes activation by itself.</p>",
    "</div>",
  ].join("");

  // Page-side script deliberately avoids template literals so it can live
  // inside this builder's own template string.
  const script = `
<script>
(function () {
  var LABELS = ${JSON.stringify(codeLabels(config))};
  var search = location.search.substring(1);
  var hash = location.hash.substring(1);
  // Real payments carry status/tx_ref inside the hash (Flutterwave appends
  // after the fragment); split on both separators and rejoin cleanly.
  var combined = (search + "&" + hash).replace(/\\?/g, "&");
  var params = new URLSearchParams(combined);
  var status = params.get("status") || "";
  var rawRef = (params.get("tx_ref") || "").toUpperCase();
  var appId = params.get("app_id") || "";
  var valid = /^KIRI-[A-Z]-[A-Z0-9_-]{20,}$/.test(rawRef);
  var id = valid ? rawRef : "";
  var label = valid ? (LABELS[rawRef.split("-")[1]] || "") : "";
  if (label) label = label.charAt(0).toUpperCase() + label.slice(1);

  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }
  function panel(which) {
    ["verify", "failed", "neutral"].forEach(function (name) {
      var el = document.getElementById("panel-" + name);
      if (name === which) show(el); else hide(el);
    });
  }

  var idcard = document.getElementById("idcard");
  var idWarn = document.getElementById("id-warn");
  var idLabel = document.getElementById("id-label");
  var recovery = document.getElementById("recovery");
  if (id) {
    if (recovery) recovery.textContent = id;
    show(idcard);
    hide(idWarn);
    if (label && idLabel) { idLabel.textContent = label + " license."; show(idLabel); }
  } else {
    hide(idcard);
    show(idWarn);
    hide(idLabel);
  }

  var copyBtn = document.getElementById("copy");
  if (copyBtn && id) {
    copyBtn.addEventListener("click", function () {
      function ok() { copyBtn.textContent = "Copied"; }
      function fallback() {
        var range = document.createRange();
        range.selectNode(recovery);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        try { document.execCommand("copy"); ok(); } catch (e) {}
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(id).then(ok, fallback);
      } else { fallback(); }
    });
  }

  function finish(kind, data) {
    var dot = document.querySelector("#panel-verify .dot");
    var text = document.getElementById("check-text");
    var done = document.getElementById("check-done");
    if (dot) dot.className = "dot " + (kind === "active" ? "ok" : "warn");
    if (text) text.hidden = true;
    if (done) {
      done.hidden = false;
      if (kind === "active") {
        var until = data && data.paid_through
          ? " through " + new Date(data.paid_through).toISOString().slice(0, 10)
          : "";
        done.innerHTML = "<strong>License confirmed" + until + "</strong><p>Open the app: it unlocks automatically. No further steps.</p>";
      } else if (kind === "scope") {
        done.innerHTML = "<strong>This license belongs to another app</strong><p>Open the app you bought it in, or use Restore purchases with the ID above.</p>";
      } else {
        done.innerHTML = "<strong>Still processing</strong><p>Flutterwave is confirming the charge. Return to the app; it finishes itself once the check lands. If nothing happens after a minute, tap Restore purchases and paste the ID above.</p>";
      }
    }
  }

  if (!status || !id) {
    // Either half missing: no usable reference, or no reported result yet.
    panel(status && !id ? "failed" : "neutral");
    return;
  }
  if (status !== "successful") { panel("failed"); return; }

  panel("verify");
  var attempt = 0;
  function check() {
    attempt += 1;
    fetch("/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recovery_id: id, app_id: appId || "unknown" })
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
</script>`;

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
  .panel[hidden] { display: none; }
  .panel.bad { border-color: #d7737d; }
  .panel p { margin: 8px 0 0; color: #5b6675; font-size: 14px; line-height: 1.5; }
  .idcard { background: #f0f3f8; border: 1px dashed #c7d0dd; border-radius: 8px;
            padding: 16px; text-align: center; margin-bottom: 8px; }
  .idcard[hidden] { display: none; }
  .cap { font-size: 11px; color: #5b6675; margin-bottom: 8px; letter-spacing: .04em; }
  .rid { display: block; font-size: 15px; color: #1a7f37; letter-spacing: 1px;
         word-break: break-all; margin-bottom: 12px; }
  button { background: #1f6feb; color: #fff; border: 0; border-radius: 6px;
           padding: 8px 18px; font-size: 14px; cursor: pointer; }
  button:hover { background: #2a76f5; }
  .muted { color: #5b6675; font-size: 13px; }
  .muted[hidden] { display: none; }
  .row { display: flex; align-items: center; gap: 10px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #d29922; flex: none; }
  .dot.ok { background: #2ea043; }
  .dot.warn { background: #d29922; }
  .dot.pulse { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .3; } }
  .done strong { display: block; margin-bottom: 6px; }
  .done p { margin: 0; color: #5b6675; font-size: 14px; line-height: 1.5; }
  .foot { color: #6b7280; font-size: 12px; margin-top: 20px; }
  .foot a { color: #1f6feb; }
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
    .foot { color: #6b7280; }
    .foot a { color: #6cb0ff; }
  }
</style>
</head>
<body>
<main>
  <img class="brand" src="https://kiri.ng/static/images/logos/logo.webp"
       onerror="this.src='https://kiri.ng/static/images/logos/logo.png'"
       alt="Kiri Research Labs" height="56">
  <h1>Payment received</h1>
  <p class="sub">Kiri Research Labs</p>
  ${panels}
  ${idCard}
  <p class="muted">Open the app to finish. It detects your payment automatically.</p>
  <p class="foot">Questions? Reply to your receipt email or contact <a href="mailto:support@kiri.ng">support@kiri.ng</a>.</p>
</main>
${script}
</body>
</html>`;
}
