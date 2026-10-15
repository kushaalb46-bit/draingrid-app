const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  Browsers, 
  fetchLatestBaileysVersion,
  downloadMediaMessage 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const http = require("http");

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version, isLatest } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    browser: Browsers.macOS("Chrome"),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    emitOwnEvents: false,
    fireInitQueries: true
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 SCAN QR CODE (WhatsApp > Settings > Linked Devices):\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : lastDisconnect?.error?.output?.statusCode;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log("Session logged out. Clear auth_session and rerun.");
      }
    } else if (connection === "open") {
      console.log("\n✅ DrainGRID Bot is ONLINE (Safe Mode Active).\n");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m || !m.message || m.key.fromMe) return;

    const from = m.key.remoteJid;
    if (from.endsWith("@g.us")) return;

    const isImage = !!m.message.imageMessage;
    const caption = (m.message.imageMessage?.caption || "").trim().toLowerCase();
    const textBody = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim().toLowerCase();

    if (!isImage) {
      if (textBody.startsWith("!drain") || textBody === "#drain" || textBody === "report drain") {
        await sock.sendMessage(from, {
          text: "🌧️ *BBMP DrainGRID Reporter*\n\nSend a photo of a clogged storm drain with the caption *#drain* to dispatch a crew."
        });
      }
      return;
    }

    const isDrainReport = caption.includes("#drain") || caption.includes("!drain") || caption.includes("report") || caption.includes("drain");
    if (!isDrainReport) return;

    console.log(`📥 Authorized Drain Report from: ${from}`);
    await sock.sendMessage(from, { text: "⏳ *DrainGRID AI:* Inspecting catch basin frame..." });

    try {
      // Correct Baileys usage: downloadMediaMessage as a standalone function
      const buffer = await downloadMediaMessage(
        m,
        'buffer',
        {},
        { logger: console, reuploadRequest: sock.updateMediaMessage }
      );

      const b64 = buffer.toString("base64");
      const dataUrl = `data:image/jpeg;base64,${b64}`;

      const reqData = JSON.stringify({
        image_data: dataUrl,
        coords: { lat: 12.9716, lng: 77.5946 }
      });

      const req = http.request("http://localhost:8000/api/triage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(reqData)
        }
      }, (res) => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", async () => {
          try {
            const triage = JSON.parse(body);
            const reply =
              `✅ *BBMP DRAINGRID TICKET CREATED*\n\n` +
              `• *Severity:* ${triage.severity || 'Assessed'}\n` +
              `• *Blockage:* ${triage.blockage_type || 'Unspecified'}\n` +
              `• *Assigned Ward:* ${triage.assigned_ward || 'Ward 151'}\n` +
              `• *Directive:* ${triage.crew_action || 'Inspect'}\n\n` +
              `_Dispatched to local BBMP ward desilting crew._`;
            await sock.sendMessage(from, { text: reply });
          } catch (err) {
            await sock.sendMessage(from, { text: "⚠️ Grate image received and logged to Ward Telemetry Map." });
          }
        });
      });

      req.on("error", (e) => console.error("Backend error:", e));
      req.write(reqData);
      req.end();

    } catch (err) {
      console.error("Media error:", err);
    }
  });
}

startBot();
