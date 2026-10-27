import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

const env = {
  OPENAI_API_KEY: "sk-test",
  DEVICE_KEYS: JSON.stringify({ "robot-1": "s3cret" }),
  MODEL: "gpt-realtime-2.1-mini",
  VOICE: "marin",
  TRANSCRIBE_MODEL: "gpt-4o-mini-transcribe",
  TOKEN_TTL_SECONDS: "120",
};

const app = createApp({ instructions: "PROMPT", testPage: "<html>test</html>" });
const realFetch = globalThis.fetch;
let calls;

beforeEach(() => {
  calls = [];
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
  assert.deepEqual(await res.json(), {
    client_secret: "ek_abc",
    expires_at: 1234,
    model: "gpt-realtime-2.1-mini",
  });

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
