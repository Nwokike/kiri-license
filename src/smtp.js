// Minimal SMTP submission client (Brevo-compatible) over Workers TCP sockets.
//
// The runtime's startTls() only upgrades the transport — the protocol-level
// STARTTLS command and every other SMTP line are ours to speak and verify, so
// each reply code is checked and any mismatch throws.
//
// `connect` is injectable (deps.connect, else globalThis.__kiri_smtp_connect)
// so node:test can drive a scripted fake; in the Worker it resolves to
// cloudflare:sockets via a dynamic import, which keeps plain-node test runs
// from failing on that scheme.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64(value) {
  const bytes = encoder.encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// CRLF-normalize and dot-stuff per RFC 5321 §4.5.2 so bodies starting with a
// dot cannot terminate DATA early.
function dotStuff(text) {
  const normalized = String(text).replace(/\r\n|\r|\n/g, "\r\n");
  return normalized.replace(/(^|\r\n)\./g, (match, prefix) => `${prefix}..`);
}

async function resolveConnect(deps) {
  if (typeof deps.connect === "function") return deps.connect;
  if (typeof globalThis.__kiri_smtp_connect === "function") return globalThis.__kiri_smtp_connect;
  const sockets = await import("cloudflare:sockets");
  return sockets.connect;
}

class Connection {
  constructor(socket, alreadySecure = false) {
    this.secure = alreadySecure;
    this.socket = socket;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buffer = "";
  }

  static async open(connect, host, port, secure) {
    // Implicit TLS (465): the handshake happens inside connect()/opened.
    // The 587 STARTTLS upgrade path exists too, but startTls() stalls on
    // Workers (verified against Brevo: greeting/EHLO/220 all fine, the
    // upgrade itself never completes), so production uses 465.
    const socket = connect(`${host}:${port}`, {
      secureTransport: secure ? "on" : "starttls",
    });
    await socket.opened;
    return new Connection(socket, secure);
  }

  async write(text) {
    await this.writer.write(encoder.encode(text));
  }

  async upgradeTls() {
    // The old socket (and its reader/writer) die here; buffers do not carry
    // over — a correct server sends nothing between 220 and the new EHLO.
    const secure = this.socket.startTls();
    await secure.opened;
    const previous = this.socket;
    this.attach(secure);
    try {
      previous.close();
    } catch {
      // Already closed by the upgrade — nothing to do.
    }
  }

  async readLine() {
    for (;;) {
      const newline = this.buffer.indexOf("\r\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 2);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) {
        const rest = this.buffer;
        this.buffer = "";
        return rest;
      }
      if (value) this.buffer += decoder.decode(value, { stream: true });
    }
  }

  async expect(expectedCode) {
    const lines = [];
    let firstCode = "";
    for (;;) {
      const line = await this.readLine();
      if (line === "") throw new Error("smtp: connection closed while reading reply");
      lines.push(line);
      if (!firstCode) firstCode = line.slice(0, 3);
      if (line.length < 4 || line[3] === " ") break;
    }
    const code = Number.parseInt(firstCode, 10);
    if (code !== expectedCode) {
      throw new Error(`smtp: expected ${expectedCode}, got ${code} (${lines.join(" | ")})`);
    }
    return lines;
  }

  async command(line, expectedCode) {
    await this.write(`${line}\r\n`);
    return this.expect(expectedCode);
  }

  close() {
    try {
      this.reader.releaseLock();
    } catch {
      // Already released.
    }
    try {
      this.writer.releaseLock();
    } catch {
      // Already released.
    }
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one HTML email over STARTTLS SMTP. Throws on any protocol error —
 * callers decide whether failure is fatal (it never is for receipts).
 * Errors carry the stage that failed so a timeout tells us WHERE the
 * connection stalled (connect/greeting/ehlo/starttls/auth/...).
 *
 * message: { host, port, user, pass, from, to, headers, html }
 * deps:    { connect } for tests
 */
export async function sendSmtp(message, deps = {}) {
  const connect = await resolveConnect(deps);
  let stage = "connect";
  try {
    return await withTimeout(
      deliver(connect, message, (next) => { stage = next; }),
      15000,
      "smtp send",
    );
  } catch (error) {
    throw new Error(`smtp ${stage}: ${String((error && error.message) || error)}`);
  }
}

async function deliver(connect, message, onStage) {
  const secure = Number(message.port) === 465;
  onStage("connect");
  const conn = await Connection.open(connect, message.host, message.port, secure);
  try {
    onStage("greeting");
    await conn.expect(220);
    onStage("ehlo");
    await conn.command("EHLO license.kiri.ng", 250);
    if (!conn.secure) {
      onStage("starttls");
      await conn.command("STARTTLS", 220);
      onStage("tls-upgrade");
      await conn.upgradeTls();
      onStage("ehlo-secure");
      await conn.command("EHLO license.kiri.ng", 250);
    }
    onStage("auth");
    await conn.command("AUTH LOGIN", 334);
    await conn.command(base64(message.user), 334);
    await conn.command(base64(message.pass), 235);
    onStage("envelope");
    await conn.command(`MAIL FROM:<${message.from}>`, 250);
    await conn.command(`RCPT TO:<${message.to}>`, 250);
    onStage("data");
    await conn.command("DATA", 354);
    const payload = dotStuff(`${message.headers}\r\n\r\n${message.html}`);
    await conn.write(`${payload}${payload.endsWith("\r\n") ? "" : "\r\n"}.\r\n`);
    await conn.expect(250);
    onStage("quit");
    await conn.write("QUIT\r\n");
    return true;
  } finally {
    conn.close();
  }
}
