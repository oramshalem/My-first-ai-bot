// Conversation log in D1. Text only: no audio is ever stored.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     device_id TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     model TEXT,
     voice TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     text TEXT,
     ms INTEGER
   )`,
  "CREATE INDEX IF NOT EXISTS events_by_session ON events (session_id, at)",
  "CREATE INDEX IF NOT EXISTS sessions_by_start ON sessions (started_at)",
];

// What devices may report. auth_failed and upstream_error are written by the server only.
const DEVICE_EVENT_KINDS = new Set(["kid", "robot", "latency", "status", "error", "end"]);
const MAX_EVENTS_PER_REQUEST = 50;
const MAX_TEXT_LENGTH = 2000;

// Tables are created on first use, so a fresh database needs no migration step.
const initialized = new WeakSet();
export async function initSchema(db) {
  if (initialized.has(db)) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  initialized.add(db);
}

export async function createSession(db, { deviceId, model, voice }) {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO sessions (id, device_id, started_at, model, voice) VALUES (?, ?, ?, ?, ?)")
    .bind(id, deviceId, Date.now(), model ?? null, voice ?? null)
    .run();
  return id;
}

export async function sessionBelongsTo(db, sessionId, deviceId) {
  const row = await db.prepare("SELECT device_id FROM sessions WHERE id = ?").bind(sessionId).first();
  return row?.device_id === deviceId;
}

// sessionId null marks a server-side event that is not tied to a conversation.
export async function addEvents(db, sessionId, events) {
  const now = Date.now();
  const rows = events
    .slice(0, MAX_EVENTS_PER_REQUEST)
    .filter((e) => e && (sessionId === null || DEVICE_EVENT_KINDS.has(e.kind)))
    .map((e) => [
      sessionId,
      Number.isFinite(e.at) ? Math.trunc(e.at) : now,
      String(e.kind),
      typeof e.text === "string" ? e.text.slice(0, MAX_TEXT_LENGTH) : null,
      Number.isFinite(e.ms) ? Math.round(e.ms) : null,
    ]);
  if (rows.length === 0) return 0;

  const stmt = db.prepare("INSERT INTO events (session_id, at, kind, text, ms) VALUES (?, ?, ?, ?, ?)");
  await db.batch(rows.map((r) => stmt.bind(...r)));
  return rows.length;
}

export async function listSessions(db, limit = 100) {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.device_id, s.started_at, s.model, s.voice,
              MAX(e.at) AS last_event_at,
              SUM(e.kind = 'kid') AS kid_turns,
              SUM(e.kind = 'robot') AS robot_turns,
              SUM(e.kind = 'error') AS errors,
              SUM(e.kind = 'latency') AS latency_count,
              AVG(CASE WHEN e.kind = 'latency' THEN e.ms END) AS avg_latency_ms
       FROM sessions s
       LEFT JOIN events e ON e.session_id = s.id
       GROUP BY s.id
       ORDER BY s.started_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results;
}

export async function listRejected(db, limit = 20) {
  const { results } = await db
    .prepare("SELECT at, kind, text FROM events WHERE session_id IS NULL ORDER BY at DESC LIMIT ?")
    .bind(limit)
    .all();
  return results;
}

export async function sessionEvents(db, sessionId) {
  const { results } = await db
    .prepare("SELECT at, kind, text, ms FROM events WHERE session_id = ? ORDER BY at, id")
    .bind(sessionId)
    .all();
  return results;
}
