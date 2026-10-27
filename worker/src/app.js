// Token server logic. Kept free of Wrangler-specific imports so it can be
// tested with plain `node --test`.

import { initSchema, createSession, addEvents, sessionBelongsTo, listSessions, listRejected, sessionEvents } from "./db.js";

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

export function createApp({ instructions, testPage, logsPage }) {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      if (env.DB) await initSchema(env.DB);

      if (request.method === "GET" && pathname === "/") return html(testPage);
      if (request.method === "GET" && pathname === "/logs") return html(logsPage);
      if (request.method === "POST" && pathname === "/token") return handleToken(request, env, instructions);
      if (request.method === "POST" && pathname === "/log") return handleLog(request, env);
      if (request.method === "GET" && pathname.startsWith("/api/")) return handleApi(request, env, pathname);
      return json({ error: "not_found" }, 404);
    },
  };
}

// The device sends its id in X-Device-Id and its secret as a bearer token.
// On success it gets a short-lived OpenAI client secret, never the API key.
async function handleToken(request, env, instructions) {
  const deviceId = request.headers.get("x-device-id") ?? "";
  if (!(await authenticateDevice(request, env))) {
    await safeLog(env, () => addEvents(env.DB, null, [{ kind: "auth_failed", text: deviceId.slice(0, 100) }]));
    return json({ error: "unauthorized" }, 401);
  }

  let upstream;
  try {
    upstream = await fetch(OPENAI_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(sessionConfig(env, instructions)),
    });
  } catch (err) {
    console.error("OpenAI request failed", err);
    await safeLog(env, () => addEvents(env.DB, null, [{ kind: "upstream_error", text: String(err) }]));
    return json({ error: "upstream_unreachable" }, 502);
  }

  if (!upstream.ok) {
    const body = await upstream.text();
    console.error("OpenAI client_secrets error", upstream.status, body);
    await safeLog(env, () => addEvents(env.DB, null, [{ kind: "upstream_error", text: `${upstream.status} ${body}` }]));
    return json({ error: "upstream_error" }, 502);
  }

  const data = await upstream.json();
  const sessionId = await safeLog(env, () => createSession(env.DB, { deviceId, model: env.MODEL, voice: env.VOICE }));
  console.log("token issued", { deviceId, model: env.MODEL, sessionId });
  return json({
    client_secret: data.value,
    expires_at: data.expires_at,
    model: env.MODEL,
    session_id: sessionId ?? null,
  });
}

// Devices report what happened during a conversation: transcripts, latency, errors.
async function handleLog(request, env) {
  if (!(await authenticateDevice(request, env))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "logging_disabled" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const deviceId = request.headers.get("x-device-id");
  if (typeof body.session_id !== "string" || !(await sessionBelongsTo(env.DB, body.session_id, deviceId))) {
    return json({ error: "unknown_session" }, 404);
  }
  const accepted = await addEvents(env.DB, body.session_id, Array.isArray(body.events) ? body.events : []);
  return json({ accepted });
}

async function handleApi(request, env, pathname) {
  if (!(await authenticateAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "logging_disabled" }, 503);

  if (pathname === "/api/sessions") {
    const [sessions, rejected] = await Promise.all([listSessions(env.DB), listRejected(env.DB)]);
    return json({ sessions, rejected, model: env.MODEL, voice: env.VOICE });
  }
  const match = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
  if (match) return json({ events: await sessionEvents(env.DB, match[1]) });
  return json({ error: "not_found" }, 404);
}

export function sessionConfig(env, instructions) {
  return {
    expires_after: { anchor: "created_at", seconds: Number(env.TOKEN_TTL_SECONDS) || 120 },
    session: {
      type: "realtime",
      model: env.MODEL,
      instructions,
      audio: {
        input: {
          // Text transcript of what the child said, for the parent log.
          transcription: { model: env.TRANSCRIBE_MODEL, language: "he" },
          // Semantic VAD copes better with children pausing mid-sentence.
          turn_detection: { type: "semantic_vad", eagerness: "auto" },
        },
        output: { voice: env.VOICE },
      },
    },
  };
}

// DEVICE_KEYS is a JSON object secret: {"robot-1": "<secret>", "browser-test": "<secret>"}.
async function authenticateDevice(request, env) {
  const deviceId = request.headers.get("x-device-id") ?? "";
  const deviceSecret = bearer(request);
  if (!deviceId || !deviceSecret) return false;

  let devices;
  try {
    devices = JSON.parse(env.DEVICE_KEYS ?? "");
  } catch {
    console.error("DEVICE_KEYS is missing or not valid JSON");
    return false;
  }
  if (!devices || !Object.hasOwn(devices, deviceId) || typeof devices[deviceId] !== "string") {
    return false;
  }
  return constantTimeEqual(deviceSecret, devices[deviceId]);
}

async function authenticateAdmin(request, env) {
  const password = bearer(request);
  if (!env.ADMIN_PASSWORD || !password) return false;
  return constantTimeEqual(password, env.ADMIN_PASSWORD);
}

function bearer(request) {
  return (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
}

// Compare SHA-256 digests so the comparison time does not depend on the secret.
async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// Logging must never stop the robot from talking.
async function safeLog(env, fn) {
  if (!env.DB) return undefined;
  try {
    return await fn();
  } catch (err) {
    console.error("logging failed", err);
    return undefined;
  }
}

function html(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
