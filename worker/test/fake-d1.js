// Minimal in-memory stand-in for the D1 API surface the Worker uses.
import { DatabaseSync } from "node:sqlite";

export function createFakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args),
    run: async () => {
      sqlite.prepare(sql).run(...params);
      return { success: true };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...params).map((r) => ({ ...r })) }),
    first: async () => {
      const row = sqlite.prepare(sql).get(...params);
      return row ? { ...row } : null;
    },
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
  };
}
