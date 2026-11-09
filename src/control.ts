import type { Store } from "./store.ts";
import type { ReportInput } from "./types.ts";

const draftLifetime = 15 * 60_000;
const maxDrafts = 500;
interface Draft {
  input: ReportInput;
  state:
    "modal" | "pending" | "submitting" | "submitted" | "cancelled" | "expired";
  expiresAt: number;
  openedAt: number;
}

export class Control {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly drafts = new Map<string, Draft>();
  constructor(private readonly store: Store) {
    store.db.exec(`
            CREATE TABLE IF NOT EXISTS confirmations (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runtime_lease (
                id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL
            );
        `);
    store.db
      .exec(`UPDATE actions SET confirm_until=MIN(confirm_until,created_at+30000),
      payload=json_set(payload,'$.confirmUntil',MIN(confirm_until,created_at+30000))
      WHERE state='pending' AND id IN (SELECT id FROM confirmations WHERE kind='action');`);
    store.db
      .query(
        "UPDATE confirmations SET expires_at=MIN(expires_at,COALESCE((SELECT confirm_until FROM actions WHERE actions.id=confirmations.id),?))",
      )
      .run(Date.now() + 30_000);
  }

  async locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.locks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(key) === task) this.locks.delete(key);
    }
  }

  lease(owner: string, now = Date.now()): boolean {
    return (
      this.store.db
        .query(
          `INSERT INTO runtime_lease(id,owner,expires_at) VALUES(1,?,?)
            ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
            WHERE runtime_lease.owner=excluded.owner OR runtime_lease.expires_at<=?`,
        )
        .run(owner, now + 20_000, now).changes === 1
    );
  }

  releaseLease(owner: string): void {
    this.store.db.query("DELETE FROM runtime_lease WHERE owner=?").run(owner);
  }

  confirmation(
    id: string,
    kind: "action" | "report",
    token: string,
    expiresAt: number,
  ): void {
    this.store.db
      .query(
        "INSERT OR REPLACE INTO confirmations(id,kind,token,expires_at) VALUES(?,?,?,?)",
      )
      .run(id, kind, token, Math.min(expiresAt, Date.now() + 30_000));
  }

  forgetConfirmation(id: string): void {
    this.store.db.query("DELETE FROM confirmations WHERE id=?").run(id);
  }

  dueConfirmations(now = Date.now()) {
    return this.store.db
      .query<
        { id: string; kind: string; token: string; expires_at: number },
        [number]
      >("SELECT * FROM confirmations WHERE expires_at<=? LIMIT 20")
      .all(now);
  }

  confirmations() {
    return this.store.db
      .query<
        { id: string; kind: string; token: string; expires_at: number },
        []
      >("SELECT * FROM confirmations")
      .all();
  }

  draft(input: ReportInput, expiresAt: number): void {
    const now = Date.now();
    this.expireDrafts(now);
    if (this.drafts.has(input.id))
      throw new Error("Report draft already exists");
    while (this.drafts.size >= maxDrafts)
      this.drafts.delete(this.drafts.keys().next().value!);
    this.drafts.set(input.id, {
      input: structuredClone(input),
      state: "modal",
      openedAt: now,
      expiresAt: Math.min(expiresAt, now + draftLifetime),
    });
  }

  getDraft(
    id: string,
    ownerId: string,
  ): { input: ReportInput; state: string; expiresAt: number } | null {
    const draft = this.drafts.get(id);
    if (!draft || draft.input.reporterId !== ownerId) return null;
    if (draft.expiresAt <= Date.now()) {
      this.drafts.delete(id);
      return null;
    }
    return {
      input: structuredClone(draft.input),
      state: draft.state,
      expiresAt: draft.expiresAt,
    };
  }

  recentDraftCount(ownerId: string, since: number): number {
    this.expireDrafts();
    let count = 0;
    for (const draft of this.drafts.values()) {
      if (
        draft.input.reporterId === ownerId &&
        draft.openedAt > since &&
        ["modal", "pending", "submitting", "submitted"].includes(draft.state)
      )
        count++;
    }
    return count;
  }

  updateDraft(input: ReportInput, expiresAt: number): boolean {
    const draft = this.drafts.get(input.id);
    if (
      !draft ||
      draft.input.reporterId !== input.reporterId ||
      draft.state !== "modal" ||
      draft.expiresAt <= Date.now()
    )
      return false;
    draft.input = structuredClone(input);
    draft.state = "pending";
    draft.expiresAt = Math.min(expiresAt, draft.openedAt + draftLifetime);
    return true;
  }

  /** Claim and commit synchronously; no message body is written to SQLite. */
  submitDraft(input: ReportInput, commit: () => void): boolean {
    const draft = this.drafts.get(input.id);
    if (
      !draft ||
      draft.input.reporterId !== input.reporterId ||
      draft.state !== "modal" ||
      draft.expiresAt <= Date.now()
    )
      return false;
    const saved = structuredClone(input);
    draft.state = "submitting";
    try {
      commit();
      draft.input = saved;
      draft.state = "submitted";
      return true;
    } catch (error) {
      draft.state = "modal";
      throw error;
    }
  }

  finishDraft(
    id: string,
    ownerId: string,
    state: "submitted" | "cancelled" | "expired",
  ): boolean {
    const draft = this.drafts.get(id);
    if (
      !draft ||
      draft.input.reporterId !== ownerId ||
      draft.state !== "pending" ||
      draft.expiresAt <= Date.now()
    )
      return false;
    draft.state = state;
    return true;
  }

  expireDrafts(now = Date.now()): void {
    for (const [id, draft] of this.drafts)
      if (draft.expiresAt <= now) this.drafts.delete(id);
  }
}
