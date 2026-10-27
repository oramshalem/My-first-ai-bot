import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createFakeD1 } from "./fake-d1.js";

const baseEnv = {
  PROVIDER: "openai",
  OPENAI_API_KEY: "sk-test",
  GEMINI_API_KEY: "AIza-test",
  ADMIN_PASSWORD: "parent-pass",
  DEVICE_KEYS: JSON.stringify({ "robot-1": "s3cret" }),
  OPENAI_MODEL: "gpt-realtime-2.1-mini",
  OPENAI_VOICE: "marin",
  OPENAI_TRANSCRIBE_MODEL: "gpt-4o-mini-transcribe",
  GEMINI_MODEL: "gemini-3.8-live",
  GEMINI_VOICE: "Puck",
  GEMINI_API_VERSION: "v1alpha",
  TOKEN_TTL_SECONDS: "120",
};

const app = createApp({ instructions: "PROMPT", testPage: "<html>test</html>", logsPage: "<html>logs</html>" });
const realFetch = globalThis.fetch;
let calls;
let env;

beforeEach(() => {
  calls = [];
  env = { ...baseEnv, DB: createFakeD1() };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ value: "ek_abc", expires_at: 1234 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function tokenRequest(headers = {}) {
  return new Request("https://worker.test/token", { method: "POST", headers });
}

const ROBOT = { "x-device-id": "robot-1", authorization: "Bearer s3cret" };

async function startSession() {
  const res = await app.fetch(tokenRequest(ROBOT), env);
  return (await res.json()).session_id;
}

function logRequest(body, headers = ROBOT) {
  return new Request("https://worker.test/log", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function adminGet(path, password = "parent-pass") {
  return new Request("https://worker.test" + path, { headers: { authorization: "Bearer " + password } });
}

test("serves the test page", async () => {
  const res = await app.fetch(new Request("https://worker.test/"), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<html>test</html>");
});

test("unknown route returns 404", async () => {
  const res = await app.fetch(new Request("https://worker.test/nope"), env);
  assert.equal(res.status, 404);
});

for (const [name, headers] of [
  ["no credentials", {}],
  ["wrong secret", { "x-device-id": "robot-1", authorization: "Bearer nope" }],
  ["unknown device", { "x-device-id": "robot-2", authorization: "Bearer s3cret" }],
  ["prototype key as device id", { "x-device-id": "toString", authorization: "Bearer x" }],
]) {
  test(`rejects ${name}`, async () => {
    const res = await app.fetch(tokenRequest(headers), env);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
}

test("rejects everything when DEVICE_KEYS is malformed", async () => {
  const res = await app.fetch(
    tokenRequest({ "x-device-id": "robot-1", authorization: "Bearer s3cret" }),
    { ...env, DEVICE_KEYS: "not json" },
  );
  assert.equal(res.status, 401);
});

test("issues a client secret for a known device", async () => {
  const res = await app.fetch(
    tokenRequest({ "x-device-id": "robot-1", authorization: "Bearer s3cret" }),
    env,
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.provider, "openai");
  assert.equal(data.client_secret, "ek_abc");
  assert.equal(data.expires_at, 1234);
  assert.equal(data.model, "gpt-realtime-2.1-mini");
  assert.match(data.session_id, /^[0-9a-f-]{36}$/);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/realtime/client_secrets");
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.session.model, "gpt-realtime-2.1-mini");
  assert.equal(body.session.instructions, "PROMPT");
  assert.equal(body.session.audio.output.voice, "marin");
  assert.equal(body.expires_after.seconds, 120);
});

test("returns 502 when OpenAI rejects the request", async () => {
  globalThis.fetch = async () => new Response("bad", { status: 500 });
  const res = await app.fetch(
    tokenRequest({ "x-device-id": "robot-1", authorization: "Bearer s3cret" }),
    env,
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "upstream_error");
});

test("returns 502 when OpenAI is unreachable", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  const res = await app.fetch(
    tokenRequest({ "x-device-id": "robot-1", authorization: "Bearer s3cret" }),
    env,
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "upstream_unreachable");
});

test("still issues a token when there is no database", async () => {
  const res = await app.fetch(tokenRequest(ROBOT), { ...env, DB: undefined });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).session_id, null);
});

test("logs a conversation and shows it to the parent", async () => {
  const sessionId = await startSession();
  const res = await app.fetch(
    logRequest({
      session_id: sessionId,
      events: [
        { at: 1000, kind: "kid", text: "שלום פיקו" },
        { at: 2000, kind: "latency", ms: 900 },
        { at: 2100, kind: "robot", text: "שלום!" },
        { at: 3000, kind: "latency", ms: 1500 },
        { at: 3100, kind: "auth_failed", text: "devices cannot write server kinds" },
      ],
    }),
    env,
  );
  assert.deepEqual(await res.json(), { accepted: 4 });

  const list = await (await app.fetch(adminGet("/api/sessions"), env)).json();
  assert.equal(list.sessions.length, 1);
  const s = list.sessions[0];
  assert.equal(s.device_id, "robot-1");
  assert.equal(s.kid_turns, 1);
  assert.equal(s.latency_count, 2);
  assert.equal(s.avg_latency_ms, 1200);
  assert.deepEqual(list.rejected, []);

  const { events } = await (await app.fetch(adminGet("/api/sessions/" + sessionId), env)).json();
  assert.deepEqual(events.map((e) => e.kind), ["kid", "latency", "robot", "latency"]);
  assert.equal(events[0].text, "שלום פיקו");
});

test("records rejected token requests", async () => {
  await app.fetch(tokenRequest({ "x-device-id": "stranger", authorization: "Bearer x" }), env);
  const list = await (await app.fetch(adminGet("/api/sessions"), env)).json();
  assert.equal(list.rejected.length, 1);
  assert.equal(list.rejected[0].kind, "auth_failed");
  assert.equal(list.rejected[0].text, "stranger");
});

test("records OpenAI failures", async () => {
  globalThis.fetch = async () => new Response("quota", { status: 429 });
  await app.fetch(tokenRequest(ROBOT), env);
  const list = await (await app.fetch(adminGet("/api/sessions"), env)).json();
  assert.equal(list.rejected[0].kind, "upstream_error");
  assert.equal(list.rejected[0].text, "openai 429 quota");
});

test("a device cannot write to another device's session", async () => {
  const sessionId = await startSession();
  const res = await app.fetch(
    logRequest(
      { session_id: sessionId, events: [{ kind: "kid", text: "x" }] },
      { "x-device-id": "browser-test", authorization: "Bearer b" },
    ),
    { ...env, DEVICE_KEYS: JSON.stringify({ "robot-1": "s3cret", "browser-test": "b" }) },
  );
  assert.equal(res.status, 404);
});

test("log endpoint requires device credentials", async () => {
  const sessionId = await startSession();
  const res = await app.fetch(logRequest({ session_id: sessionId, events: [] }, {}), env);
  assert.equal(res.status, 401);
});

for (const [name, password, extraEnv] of [
  ["wrong password", "nope", {}],
  ["no ADMIN_PASSWORD configured", "", { ADMIN_PASSWORD: undefined }],
]) {
  test(`logs API rejects ${name}`, async () => {
    const res = await app.fetch(adminGet("/api/sessions", password), { ...env, ...extraEnv });
    assert.equal(res.status, 401);
  });
}

test("serves the logs page", async () => {
  const res = await app.fetch(new Request("https://worker.test/logs"), env);
  assert.equal(await res.text(), "<html>logs</html>");
});

test("issues a locked Gemini token when PROVIDER is gemini", async () => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ name: "auth_tokens/xyz", expireTime: "2026-10-27T12:30:00Z" });
  };
  const geminiEnv = { ...env, PROVIDER: "gemini" };
  const res = await app.fetch(tokenRequest(ROBOT), geminiEnv);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.provider, "gemini");
  assert.equal(data.model, "gemini-3.8-live");
  assert.equal(data.token, "auth_tokens/xyz");
  assert.equal(
    data.ws_url,
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
  );
  assert.equal(data.expires_at, Date.parse("2026-10-27T12:30:00Z") / 1000);
  assert.ok(data.session_id);

  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1alpha/auth_tokens");
  assert.equal(calls[0].init.headers["x-goog-api-key"], "AIza-test");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.uses, 1);
  const setup = body.bidiGenerateContentSetup;
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.equal(setup.systemInstruction.parts[0].text, "PROMPT");
  assert.deepEqual(setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Puck");
  assert.deepEqual(setup.inputAudioTranscription, {});

  const list = await (await app.fetch(adminGet("/api/sessions"), geminiEnv)).json();
  assert.equal(list.provider, "gemini");
  assert.equal(list.sessions[0].model, "gemini-3.8-live");
});

test("gemini is the default provider", async () => {
  await app.fetch(tokenRequest(ROBOT), { ...env, PROVIDER: undefined });
  assert.match(calls[0].url, /generativelanguage/);
});

test("says the server is not configured when DEVICE_KEYS is missing", async () => {
  const res = await app.fetch(tokenRequest(ROBOT), { ...env, DEVICE_KEYS: undefined });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "server_not_configured");
  assert.equal(calls.length, 0);
});
