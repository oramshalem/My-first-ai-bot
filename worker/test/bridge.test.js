// End-to-end test of the xiaozhi bridge with a fake robot, a fake Gemini and a fake token server.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import OpusScript from "opusscript";
import { createBridge } from "../bridge/xiaozhi-bridge.mjs";

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

function tone(samples, amplitude) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 6) * amplitude), i * 2);
  return pcm;
}

// --- fake Gemini: greets, then answers once the child has spoken for a while
const geminiServer = http.createServer();
const gemini = { setup: null, greeting: null, audioMessages: 0, audioMime: null, audioBytes: 0 };
const geminiWss = new WebSocketServer({ server: geminiServer });
const ANSWER_SECONDS = 2;
geminiWss.on("connection", (ws, req) => {
  gemini.url = req.url;
  let answered = false;
  const answer = (kid, robot) => {
    if (kid) ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: kid } } }));
    ws.send(JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: tone(24000 * ANSWER_SECONDS, 6000).toString("base64") } }] },
        outputTranscription: { text: robot },
      },
    }));
    ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
  };
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.setup) {
      gemini.setup = msg.setup;
      ws.send(JSON.stringify({ setupComplete: {} }));
    } else if (msg.clientContent) {
      gemini.greeting = msg.clientContent.turns[0].parts[0].text;
      answer(null, "שלום! אני פיקו.");
    } else if (msg.realtimeInput?.audio) {
      gemini.audioMessages++;
      gemini.audioMime = msg.realtimeInput.audio.mimeType;
      gemini.audioBytes = Buffer.from(msg.realtimeInput.audio.data, "base64").length;
      if (gemini.audioMessages === 10 && !answered) {
        answered = true;
        setTimeout(() => answer("קוראים לי נועה", "נעים מאוד נועה!"), 200);
      }
    }
  });
});

// --- fake token server: hands out a Gemini token pointing at the fake Gemini, records logs
const logs = [];
const tokenRequests = [];
const workerServer = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.url === "/token") {
    tokenRequests.push(req.headers);
    res.end(JSON.stringify({
      provider: "gemini",
      model: "gemini-3.8-live",
      session_id: "log-session",
      token: "auth_tokens/abc",
      ws_url: `ws://127.0.0.1:${geminiPort}/ws`,
    }));
  } else if (req.url === "/log") {
    logs.push(...JSON.parse(body).events);
    res.end("{}");
  }
});

const geminiPort = await listen(geminiServer);
const workerPort = await listen(workerServer);
const pairingFile = join(mkdtempSync(join(tmpdir(), "bridge-")), "robot.json");
const bridgeLog = [];
const bridge = createBridge({
  workerUrl: `http://127.0.0.1:${workerPort}`,
  deviceId: "robot-1",
  deviceSecret: "robot-secret",
  pairingFile,
  log: (l) => bridgeLog.push(l),
});
const bridgePort = await listen(bridge);
const base = `127.0.0.1:${bridgePort}`;

after(() => {
  bridge.close();
  geminiServer.close();
  workerServer.close();
  geminiWss.clients.forEach((c) => c.terminate());
});

const ota = (mac) =>
  fetch(`http://${base}/xiaozhi/ota/`, {
    method: "POST",
    headers: { "Device-Id": mac, "Client-Id": "uuid", "content-type": "application/json" },
    body: JSON.stringify({ version: 2, mac_address: mac }),
  });

let otaAnswer;

test("the first robot to call OTA is paired and gets a WebSocket address", async () => {
  const res = await ota("AA:BB:CC:00:11:22");
  assert.equal(res.status, 200);
  otaAnswer = await res.json();
  assert.equal(otaAnswer.websocket.url, `ws://${base}/xiaozhi/v1/`);
  assert.ok(otaAnswer.websocket.token.length > 10);
  assert.equal(typeof otaAnswer.server_time.timestamp, "number");
  assert.equal(otaAnswer.firmware, undefined, "never offers a firmware update");

  const again = await (await ota("aa:bb:cc:00:11:22")).json();
  assert.equal(again.websocket.token, otaAnswer.websocket.token, "same robot, same token");
});

test("a second robot is not paired", async () => {
  const res = await ota("11:11:11:11:11:11");
  assert.equal(res.status, 403);
});

test("a WebSocket with the wrong token is refused", async () => {
  const ws = new WebSocket(otaAnswer.websocket.url, {
    headers: { Authorization: "Bearer wrong", "Device-Id": "aa:bb:cc:00:11:22", "Protocol-Version": "1" },
  });
  const [err] = await once(ws, "error");
  assert.match(err.message, /401/);
});

test("a full conversation: greeting, the child talks, the robot answers in real time", async () => {
  const robot = new WebSocket(otaAnswer.websocket.url, {
    headers: {
      Authorization: `Bearer ${otaAnswer.websocket.token}`,
      "Device-Id": "aa:bb:cc:00:11:22",
      "Client-Id": "uuid",
      "Protocol-Version": "1",
    },
  });
  await once(robot, "open");

  const decoder = new OpusScript(24000, 1, OpusScript.Application.VOIP);
  const events = []; // { t, kind, ... }
  const t0 = Date.now();
  let leadViolation = null;
  let turnStart = null;
  let framesInTurn = 0;
  robot.on("message", (data, isBinary) => {
    const t = Date.now() - t0;
    if (isBinary) {
      const samples = decoder.decode(data).length / 2;
      events.push({ t, kind: "audio", samples });
      framesInTurn++;
      // never more than ~0.5 s ahead of real time, or the robot would drop packets
      const allowed = Math.floor((Date.now() - turnStart) / 60) + 8 + 2;
      if (framesInTurn > allowed) leadViolation = `${framesInTurn} frames after ${Date.now() - turnStart} ms`;
    } else {
      const msg = JSON.parse(data.toString());
      events.push({ t, kind: msg.type, state: msg.state, msg });
      if (msg.type === "tts" && msg.state === "start") {
        turnStart = Date.now();
        framesInTurn = 0;
      }
    }
  });

  robot.send(JSON.stringify({
    type: "hello", version: 1, transport: "websocket", features: { mcp: true },
    audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 },
  }));
  robot.send(JSON.stringify({ type: "listen", state: "start", mode: "auto" }));

  const until = async (pred, ms = 10000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out; events: " + events.map((e) => e.kind + (e.state ?? "")).join(","));
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const ttsStops = () => events.filter((e) => e.kind === "tts" && e.state === "stop").length;

  await until(() => events.some((e) => e.kind === "hello"));
  const hello = events.find((e) => e.kind === "hello").msg;
  assert.equal(hello.transport, "websocket");
  assert.equal(hello.audio_params.sample_rate, 24000);
  assert.equal(hello.audio_params.frame_duration, 60);

  // greeting plays
  await until(() => ttsStops() === 1);

  // the child talks: 1.2 s of loud tone, as 60 ms Opus frames at 16 kHz
  const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  for (let i = 0; i < 20; i++) {
    robot.send(encoder.encode(tone(960, 12000), 960));
    await new Promise((r) => setTimeout(r, 60));
  }
  await until(() => ttsStops() === 2);
  robot.close();
  await new Promise((r) => setTimeout(r, 200));

  // what Gemini got
  assert.equal(gemini.setup.model, "models/gemini-3.8-live");
  assert.match(gemini.url, /access_token=auth_tokens%2Fabc/);
  assert.equal(gemini.greeting, "תגיד שלום קצר ותציג את עצמך במשפט אחד.");
  assert.equal(gemini.audioMime, "audio/pcm;rate=16000");
  assert.equal(gemini.audioBytes, 960 * 2);
  assert.equal(tokenRequests[0]["x-device-id"], "robot-1");
  assert.equal(tokenRequests[0].authorization, "Bearer robot-secret");

  // what the robot got, per turn
  const kinds = events.map((e) => (e.kind === "audio" ? "a" : e.kind + ":" + (e.state ?? ""))).join(" ").replace(/(a )+a/g, "audio…");
  assert.match(kinds, /^hello: tts:start audio… tts:stop tts:start audio… tts:stop$/);
  const turn2 = events.slice(events.findLastIndex((e) => e.kind === "tts" && e.state === "start"));
  const frames = turn2.filter((e) => e.kind === "audio");
  assert.equal(frames.length, Math.ceil((24000 * ANSWER_SECONDS) / 1440), "every 60 ms frame arrives, last one padded");
  assert.ok(frames.every((f) => f.samples === 1440));
  const played = turn2.at(-1).t - turn2[0].t;
  assert.ok(played >= (frames.length - 8) * 60 - 100, `sent in real time, not in a burst (${played} ms)`);
  assert.equal(leadViolation, null, leadViolation);

  // what the logs screen got
  const kindsLogged = logs.map((e) => e.kind);
  assert.deepEqual(kindsLogged.filter((k) => k === "kid" || k === "robot"), ["robot", "kid", "robot"]);
  assert.equal(logs.find((e) => e.kind === "kid").text, "קוראים לי נועה");
  const latency = logs.find((e) => e.kind === "latency");
  assert.ok(latency && latency.ms >= 0 && latency.ms < 2000, "latency measured from the end of the child's voice");
  assert.equal(kindsLogged.at(-1), "end");
});
