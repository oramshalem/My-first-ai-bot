// Bridge between a robot running stock xiaozhi-esp32 firmware and Gemini Live.
//
// robot  <-- xiaozhi WebSocket protocol, Opus 16 kHz up / 24 kHz down -->  bridge
// bridge <-- Gemini Live WebSocket, PCM 16 kHz up / 24 kHz down          -->  Google
//
// The bridge is just another device for the token server: it gets its Gemini
// token from POST /token as robot-1 and reports transcripts to POST /log, so
// the prompt, the key and the logs screen stay where they are.
//
// Protocol reference: docs/websocket.md in github.com/78/xiaozhi-esp32.

import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import OpusScript from "opusscript";

const IN_RATE = 16000;
const OUT_RATE = 24000;
const FRAME_MS = 60;
const OUT_FRAME_SAMPLES = (OUT_RATE * FRAME_MS) / 1000;
// The robot drops incoming packets when more than 1.2 s are queued, so audio
// is sent in real time with a small lead instead of as fast as Gemini makes it.
const LEAD_FRAMES = 8;
const VOICE_RMS = 0.02 * 32768;
const MAX_PENDING_FRAMES = 40; // mic audio kept while Gemini is still connecting
const GREETING = "תגיד שלום קצר ותציג את עצמך במשפט אחד.";

export function createBridge({ workerUrl, deviceId, deviceSecret, pairingFile, log = console.log }) {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname.startsWith("/xiaozhi/ota")) return handleOta(req, res);
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://x");
    const pairing = loadPairing();
    const mac = (req.headers["device-id"] ?? "").toLowerCase();
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!pathname.startsWith("/xiaozhi/v1") || !pairing || pairing.mac !== mac || pairing.token !== token) {
      log(`rejected robot connection from ${mac || "unknown device"}`);
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleRobot(ws, mac));
  });

  // The first robot to ask is paired, and only that robot gets the WebSocket token.
  // Delete the pairing file to pair a different board.
  function loadPairing() {
    try {
      return existsSync(pairingFile) ? JSON.parse(readFileSync(pairingFile, "utf8")) : null;
    } catch {
      return null;
    }
  }

  // The robot calls this on boot. The answer tells it where to open its WebSocket.
  function handleOta(req, res) {
    req.resume(); // the body is the robot's system info, we do not need it
    const mac = (req.headers["device-id"] ?? "").toLowerCase();
    if (!mac) return sendJson(res, 400, { error: "missing Device-Id" });

    let pairing = loadPairing();
    if (!pairing) {
      pairing = { mac, token: randomBytes(18).toString("base64url"), paired_at: new Date().toISOString() };
      writeFileSync(pairingFile, JSON.stringify(pairing, null, 2));
      log(`paired with robot ${mac}`);
    } else if (pairing.mac !== mac) {
      log(`robot ${mac} is not paired (paired: ${pairing.mac}). Delete ${pairingFile} to pair it.`);
      return sendJson(res, 403, { error: "not paired" });
    }

    sendJson(res, 200, {
      server_time: { timestamp: Date.now(), timezone_offset: -new Date().getTimezoneOffset() },
      websocket: { url: `ws://${req.headers.host}/xiaozhi/v1/`, token: pairing.token, version: 1 },
    });
  }

  function handleRobot(robot, mac) {
    const decoder = new OpusScript(IN_RATE, 1, OpusScript.Application.VOIP);
    const encoder = new OpusScript(OUT_RATE, 1, OpusScript.Application.VOIP);
    const robotSessionId = randomUUID();
    let gemini = null;
    let geminiReady = false;
    let logSessionId = null;
    let closed = false;
    const pendingMic = [];

    // what the robot is saying right now
    let speaking = false;
    let ending = false;
    let outPcm = Buffer.alloc(0);
    const outFrames = [];
    let speakStart = 0;
    let framesSent = 0;
    const pacer = setInterval(pace, 20);

    let kidText = "";
    let robotText = "";
    let lastVoiceAt = null;
    let awaitingAnswer = false;

    log(`robot ${mac} connected`);

    function report(kind, text = null, ms = null) {
      if (!logSessionId) return;
      fetch(`${workerUrl}/log`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": deviceId,
          authorization: `Bearer ${deviceSecret}`,
        },
        body: JSON.stringify({ session_id: logSessionId, events: [{ at: Date.now(), kind, text, ms }] }),
      }).catch(() => {});
    }

    function sendRobot(msg) {
      if (robot.readyState === WebSocket.OPEN) robot.send(JSON.stringify({ session_id: robotSessionId, ...msg }));
    }

    function close(reason) {
      if (closed) return;
      closed = true;
      clearInterval(pacer);
      if (reason) {
        log(`robot ${mac}: ${reason}`);
        report("error", reason);
      }
      flushRobotText();
      report("end");
      gemini?.close();
      robot.close();
      decoder.delete();
      encoder.delete();
    }

    robot.on("message", (data, isBinary) => {
      if (isBinary) return onRobotAudio(data);
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "hello") {
        sendRobot({
          type: "hello",
          transport: "websocket",
          audio_params: { format: "opus", sample_rate: OUT_RATE, channels: 1, frame_duration: FRAME_MS },
        });
        startGemini().catch((err) => close(`could not start Gemini: ${err.message}`));
      } else if (msg.type === "listen" && msg.state === "stop" && geminiReady) {
        // Manual mode on the robot: the child let go of the button.
        gemini.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      } else if (msg.type === "abort") {
        stopSpeaking();
      }
    });
    robot.on("close", () => close(null));
    robot.on("error", (err) => close(`robot socket error: ${err.message}`));

    async function startGemini() {
      const res = await fetch(`${workerUrl}/token`, {
        method: "POST",
        headers: { "x-device-id": deviceId, authorization: `Bearer ${deviceSecret}` },
      });
      if (!res.ok) throw new Error(`token server answered ${res.status}, see the logs screen`);
      const token = await res.json();
      if (token.provider !== "gemini") throw new Error(`the bridge supports Gemini only, PROVIDER is ${token.provider}`);
      logSessionId = token.session_id;
      report("status", `robot ${mac} via xiaozhi bridge`);
      if (closed) return;

      gemini = new WebSocket(`${token.ws_url}?access_token=${encodeURIComponent(token.token)}`);
      gemini.on("open", () => gemini.send(JSON.stringify({ setup: { model: `models/${token.model}` } })));
      gemini.on("message", (data) => {
        try {
          handleGemini(JSON.parse(data.toString()));
        } catch (err) {
          log(`bad message from Gemini: ${err.message}`);
        }
      });
      gemini.on("close", (code, reason) => close(`Gemini closed the connection (${code}${reason.length ? ": " + reason : ""})`));
      gemini.on("error", (err) => close(`Gemini connection error: ${err.message}`));
    }

    function onRobotAudio(packet) {
      let pcm;
      try {
        pcm = decoder.decode(packet);
      } catch {
        return;
      }
      if (rms(pcm) > VOICE_RMS && !speaking) {
        lastVoiceAt = Date.now();
        awaitingAnswer = true;
      }
      if (!geminiReady) {
        pendingMic.push(pcm);
        if (pendingMic.length > MAX_PENDING_FRAMES) pendingMic.shift();
        return;
      }
      sendMic(pcm);
    }

    function sendMic(pcm) {
      gemini.send(JSON.stringify({
        realtimeInput: { audio: { data: pcm.toString("base64"), mimeType: `audio/pcm;rate=${IN_RATE}` } },
      }));
    }

    function handleGemini(msg) {
      if (msg.setupComplete) {
        geminiReady = true;
        report("status", "connected, mode auto");
        log(`robot ${mac}: Gemini ready`);
        for (const pcm of pendingMic.splice(0)) sendMic(pcm);
        gemini.send(JSON.stringify({
          clientContent: { turns: [{ role: "user", parts: [{ text: GREETING }] }], turnComplete: true },
        }));
        return;
      }
      if (msg.goAway) log(`robot ${mac}: Gemini will close soon (${JSON.stringify(msg.goAway)})`);
      const sc = msg.serverContent;
      if (!sc) return;

      if (sc.inputTranscription?.text) kidText += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) robotText += sc.outputTranscription.text;

      for (const part of sc.modelTurn?.parts ?? []) {
        if (!part.inlineData?.mimeType?.startsWith("audio/")) continue;
        if (!speaking) startSpeaking();
        queuePcm(Buffer.from(part.inlineData.data, "base64"));
      }
      if (sc.interrupted) stopSpeaking();
      if (sc.turnComplete) {
        flushRobotText();
        if (speaking) ending = true; // tts stop goes out once the queued audio is sent
      }
    }

    function startSpeaking() {
      if (awaitingAnswer && lastVoiceAt !== null) report("latency", null, Date.now() - lastVoiceAt);
      awaitingAnswer = false;
      flushKidText();
      speaking = true;
      ending = false;
      speakStart = Date.now();
      framesSent = 0;
      sendRobot({ type: "tts", state: "start" });
    }

    function queuePcm(pcm) {
      outPcm = Buffer.concat([outPcm, pcm]);
      const frameBytes = OUT_FRAME_SAMPLES * 2;
      while (outPcm.length >= frameBytes) {
        outFrames.push(encoder.encode(outPcm.subarray(0, frameBytes), OUT_FRAME_SAMPLES));
        outPcm = outPcm.subarray(frameBytes);
      }
    }

    function pace() {
      if (!speaking) return;
      const allowed = Math.floor((Date.now() - speakStart) / FRAME_MS) + LEAD_FRAMES;
      while (outFrames.length && framesSent < allowed && robot.readyState === WebSocket.OPEN) {
        robot.send(outFrames.shift(), { binary: true });
        framesSent++;
      }
      if (ending && !outFrames.length) {
        if (outPcm.length) {
          // pad the last partial frame with silence
          queuePcm(Buffer.alloc(OUT_FRAME_SAMPLES * 2 - outPcm.length));
          return;
        }
        speaking = false;
        ending = false;
        sendRobot({ type: "tts", state: "stop" });
      }
    }

    function stopSpeaking() {
      outFrames.length = 0;
      outPcm = Buffer.alloc(0);
      flushRobotText();
      if (speaking) {
        speaking = false;
        ending = false;
        sendRobot({ type: "tts", state: "stop" });
      }
    }

    function flushKidText() {
      if (kidText.trim()) report("kid", kidText.trim());
      kidText = "";
    }

    // The child's words go first: their transcript often arrives after the answer has started.
    function flushRobotText() {
      flushKidText();
      if (robotText.trim()) report("robot", robotText.trim());
      robotText = "";
    }
  }

  return server;
}

function rms(pcm) {
  const samples = pcm.length >> 1;
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

// `node bridge/xiaozhi-bridge.mjs` (npm run local starts it next to the token server).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const devVars = new URL("../.dev.vars", import.meta.url);
  const vars = Object.fromEntries(
    readFileSync(devVars, "utf8")
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Z_]+)\s*=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );
  const robotSecret = JSON.parse(vars.DEVICE_KEYS)["robot-1"];
  const port = Number(process.env.BRIDGE_PORT) || 8788;
  createBridge({
    workerUrl: process.env.WORKER_URL || "http://127.0.0.1:8787",
    deviceId: "robot-1",
    deviceSecret: robotSecret,
    pairingFile: fileURLToPath(new URL("../.robot.json", import.meta.url)),
    log: (line) => console.log(`[robot] ${line}`),
  }).listen(port, "0.0.0.0", () => console.log(`[robot] bridge ready on port ${port}`));
}
