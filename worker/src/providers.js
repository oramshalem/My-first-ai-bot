// Speech-to-speech providers. Each one turns the character prompt into a
// short-lived token request, so the API key never leaves the server.
// PROVIDER in wrangler.toml picks which one /token uses.
//
// mode "auto" (default): always listening, the provider detects the end of speech.
// mode "push": the device says when the child starts and stops talking (push to talk).

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const GEMINI_HOST = "generativelanguage.googleapis.com";

export function providerFor(env) {
  return env.PROVIDER === "openai" ? openai : gemini;
}

const ttlSeconds = (env) => Number(env.TOKEN_TTL_SECONDS) || 120;

export const openai = {
  name: "openai",
  model: (env) => env.OPENAI_MODEL,
  voice: (env) => env.OPENAI_VOICE,

  tokenRequest(env, instructions, { mode = "auto" } = {}) {
    const body = {
      expires_after: { anchor: "created_at", seconds: ttlSeconds(env) },
      session: {
        type: "realtime",
        model: env.OPENAI_MODEL,
        instructions,
        audio: {
          input: {
            // Text transcript of what the child said, for the parent log.
            transcription: { model: env.OPENAI_TRANSCRIBE_MODEL, language: "he" },
            // Semantic VAD copes better with children pausing mid-sentence.
            // In push mode the client commits the audio buffer itself.
            // "low" waits longer before answering, so a pause mid-sentence is not taken as the end.
            turn_detection: mode === "push" ? null : { type: "semantic_vad", eagerness: "low" },
          },
          output: { voice: env.OPENAI_VOICE },
        },
      },
    };
    return [
      OPENAI_CLIENT_SECRETS_URL,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ];
  },

  // The client sends its SDP offer to https://api.openai.com/v1/realtime/calls with this secret.
  tokenResponse(env, data) {
    return { client_secret: data.value, expires_at: data.expires_at };
  },
};

export const gemini = {
  name: "gemini",
  model: (env) => env.GEMINI_MODEL,
  voice: (env) => env.GEMINI_VOICE,

  tokenRequest(env, instructions, { mode = "auto", now = Date.now() } = {}) {
    const body = {
      uses: 1,
      // How long a started conversation may last, and how soon it must start.
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + ttlSeconds(env) * 1000).toISOString(),
      // The whole session setup is locked into the token, so a client holding it
      // cannot swap the prompt, model or voice.
      bidiGenerateContentSetup: {
        model: `models/${env.GEMINI_MODEL}`,
        systemInstruction: { parts: [{ text: instructions }] },
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_VOICE } } },
        },
        // Without a hint the transcriber guesses the language and often picks Spanish or German.
        inputAudioTranscription: env.GEMINI_TRANSCRIBE_LANGUAGE
          ? { languageCodes: [env.GEMINI_TRANSCRIBE_LANGUAGE] }
          : {},
        outputAudioTranscription: {},
        ...geminiActivityDetection(env, mode),
      },
    };
    return [
      `https://${GEMINI_HOST}/${env.GEMINI_API_VERSION}/auth_tokens`,
      {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ];
  },

  // The client opens `${ws_url}?access_token=${token}` and streams 16 kHz PCM.
  tokenResponse(env, data) {
    return {
      token: data.name,
      ws_url: `wss://${GEMINI_HOST}/ws/google.ai.generativelanguage.${env.GEMINI_API_VERSION}.GenerativeService.BidiGenerateContentConstrained`,
      expires_at: data.expireTime ? Math.floor(Date.parse(data.expireTime) / 1000) : null,
    };
  },
};

function geminiActivityDetection(env, mode) {
  // In push mode the client sends activityStart / activityEnd itself.
  if (mode === "push") return { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } };
  // Children pause mid-sentence. Wait for a longer silence, and be less eager to call it the end.
  // GEMINI_SILENCE_MS = "" leaves Gemini's own defaults.
  if (!env.GEMINI_SILENCE_MS) return {};
  return {
    realtimeInputConfig: {
      automaticActivityDetection: {
        endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
        silenceDurationMs: Number(env.GEMINI_SILENCE_MS),
      },
    },
  };
}
