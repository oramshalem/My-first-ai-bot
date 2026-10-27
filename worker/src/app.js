// Token server logic. Kept free of Wrangler-specific imports so it can be
// tested with plain `node --test`.

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

export function createApp({ instructions, testPage }) {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);

      if (request.method === "GET" && pathname === "/") {
        return new Response(testPage, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "POST" && pathname === "/token") {
        return handleToken(request, env, instructions);
      }
      return json({ error: "not_found" }, 404);
    },
  };
}

// The device sends its id in X-Device-Id and its secret as a bearer token.
// On success it gets a short-lived OpenAI client secret, never the API key.
async function handleToken(request, env, instructions) {
  const deviceId = request.headers.get("x-device-id") ?? "";
  const deviceSecret = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

  if (!(await isKnownDevice(env.DEVICE_KEYS, deviceId, deviceSecret))) {
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
    return json({ error: "upstream_unreachable" }, 502);
  }

  if (!upstream.ok) {
    console.error("OpenAI client_secrets error", upstream.status, await upstream.text());
    return json({ error: "upstream_error" }, 502);
  }

  const data = await upstream.json();
  console.log("token issued", { deviceId, model: env.MODEL });
  return json({ client_secret: data.value, expires_at: data.expires_at, model: env.MODEL });
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
          // Text transcript of what the child said, for the parent log (stage 6).
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
async function isKnownDevice(deviceKeysJson, deviceId, deviceSecret) {
  if (!deviceId || !deviceSecret) return false;

  let devices;
  try {
    devices = JSON.parse(deviceKeysJson ?? "");
  } catch {
    console.error("DEVICE_KEYS is missing or not valid JSON");
    return false;
  }
  if (!devices || !Object.hasOwn(devices, deviceId) || typeof devices[deviceId] !== "string") {
    return false;
  }
  return constantTimeEqual(deviceSecret, devices[deviceId]);
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
