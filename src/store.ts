import { Database } from "bun:sqlite";
import {
  auditMetadata,
  essentialAudit,
  migrateStorage,
  outboxMetadata,
  reportMetadata,
} from "./storage-migration.ts";
import type {
  Action,
  ActionInput,
  ActionState,
  OutboxItem,
  Report,
  ReportInput,
  Sanction,
} from "./types.ts";

interface ActionRow {
  payload: string;
  state: ActionState;
  result: string | null;
  completed_at: number | null;
}
interface ReportRow {
  payload: string;
  state: Report["state"];
  mod_message_id: string | null;
  resolved_by: string | null;
  resolution: string | null;
}

function object<T>(json: string): T {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid stored JSON object");
  return value as T;
}

function action(row: ActionRow): Action {
  return {
    ...object<ActionInput>(row.payload),
    state: row.state,
    result: row.result,
    completedAt: row.completed_at,
  };
}

export class Store {
  readonly db: Database;
  private readonly reportEvidence = new Map<
    string,
    { input: ReportInput; expiresAt: number }
  >();
  private readonly outboxPayloads = new Map<
    string,
    { json: string; bytes: number; expiresAt: number }
  >();
  private outboxBytes = 0;

  constructor(path = "discord-moderation-bot.db") {
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON");
      migrateStorage(this.db);
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON",
      );
      this.db.exec(`
            CREATE TABLE IF NOT EXISTS actions (
                id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL UNIQUE, guild_id TEXT NOT NULL,
                target_id TEXT, actor_id TEXT NOT NULL, created_at INTEGER NOT NULL, confirm_until INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','succeeded','failed','cancelled','expired','uncertain')),
                payload TEXT NOT NULL CHECK(json_valid(payload)), result TEXT, completed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS actions_target ON actions(guild_id,target_id,created_at DESC);
            CREATE INDEX IF NOT EXISTS actions_state ON actions(state,confirm_until);
            CREATE TABLE IF NOT EXISTS sanctions (
                guild_id TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('mute','ban')),
                action_id TEXT NOT NULL REFERENCES actions(id), expires_at INTEGER, role_id TEXT,
                PRIMARY KEY(guild_id,target_id,kind)
            );
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','processing','resolved')),
                payload TEXT NOT NULL CHECK(json_valid(payload)), mod_message_id TEXT,
                resolved_by TEXT, resolution TEXT
            );
            CREATE INDEX IF NOT EXISTS reports_state ON reports(state);
            CREATE TABLE IF NOT EXISTS outbox (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('log','dm','report','report-edit')),
                payload TEXT NOT NULL CHECK(json_valid(payload)), attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER NOT NULL, last_error TEXT
            );
            CREATE INDEX IF NOT EXISTS outbox_due ON outbox(next_attempt_at);
            CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, event TEXT NOT NULL,
                data TEXT NOT NULL CHECK(json_valid(data))
            );
            CREATE INDEX IF NOT EXISTS audit_time ON audit(created_at);
        `);
    } catch (error) {
      this.db.close(false);
      throw error;
    }
  }

  cacheReportEvidence(input: ReportInput): void {
    const now = Date.now();
    for (const [id, entry] of this.reportEvidence)
      if (entry.expiresAt <= now) this.reportEvidence.delete(id);
    this.reportEvidence.delete(input.id);
    this.reportEvidence.set(input.id, {
      input: structuredClone(input),
      expiresAt: now + 15 * 60_000,
    });
    while (this.reportEvidence.size > 100)
      this.reportEvidence.delete(this.reportEvidence.keys().next().value!);
  }

  hasReportEvidence(id: string): boolean {
    const cached = this.reportEvidence.get(id);
    if (!cached || cached.expiresAt <= Date.now()) {
      this.reportEvidence.delete(id);
      return false;
    }
    return !!this.db.query("SELECT 1 FROM reports WHERE id=?").get(id);
  }

  clearReportEvidence(id: string): void {
    this.reportEvidence.delete(id);
  }

  private report(row: ReportRow): Report {
    const metadata = object<ReportInput>(row.payload);
    const cached = this.hasReportEvidence(metadata.id)
      ? this.reportEvidence.get(metadata.id)!.input
      : null;
    let messageTime = metadata.createdAt;
    if (/^[1-9]\d{16,19}$/.test(metadata.messageId)) {
      messageTime = Number(
        (BigInt(metadata.messageId) >> 22n) + 1_420_070_400_000n,
      );
    }
    return {
      ...metadata,
      ...(cached
        ? {
            message: structuredClone(cached.message),
            context: structuredClone(cached.context),
            contextWarning: cached.contextWarning,
            targetAvatarUrl: cached.targetAvatarUrl,
            reporterName: cached.reporterName,
          }
        : {
            message: {
              id: metadata.messageId,
              channelId: metadata.channelId,
              authorId: metadata.targetId,
              authorName: "Не сохранено",
              content: "Текст не сохранён.",
              attachments: [],
              createdAt: messageTime,
            },
            context: [],
            contextWarning:
              "Текст сообщений не сохраняется. Откройте исходное сообщение в Discord.",
          }),
      state: row.state,
      modMessageId: row.mod_message_id,
      resolvedBy: row.resolved_by,
      resolution: row.resolution,
    };
  }

  private forgetOutboxPayload(id: string): void {
    const cached = this.outboxPayloads.get(id);
    if (cached) this.outboxBytes -= cached.bytes;
    this.outboxPayloads.delete(id);
  }

  private pruneOutboxPayloads(): void {
    const now = Date.now();
    for (const [id, cached] of this.outboxPayloads)
      if (cached.expiresAt <= now) this.forgetOutboxPayload(id);
    while (
      this.outboxPayloads.size > 500 ||
      this.outboxBytes > 16 * 1024 * 1024
    )
      this.forgetOutboxPayload(this.outboxPayloads.keys().next().value!);
  }

  createAction(input: ActionInput): Action {
    this.db
      .query(
        `INSERT INTO actions(id,interaction_id,guild_id,target_id,actor_id,created_at,confirm_until,payload)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(interaction_id) DO NOTHING`,
      )
      .run(
        input.id,
        input.interactionId,
        input.guildId,
        input.targetId,
        input.actorId,
        input.createdAt,
        input.confirmUntil,
        JSON.stringify(input),
      );
    const row = this.db
      .query<ActionRow, [string]>(
        "SELECT * FROM actions WHERE interaction_id = ?",
      )
      .get(input.interactionId);
    if (!row) throw new Error("Action was not persisted");
    return action(row);
  }

  getAction(id: string): Action | null {
    const row = this.db
      .query<ActionRow, [string]>("SELECT * FROM actions WHERE id = ?")
      .get(id);
    return row ? action(row) : null;
  }

  claimAction(id: string, actorId: string, now = Date.now()): boolean {
    return (
      this.db
        .query(
          "UPDATE actions SET state = 'running' WHERE id = ? AND actor_id = ? AND state = 'pending' AND confirm_until > ?",
        )
        .run(id, actorId, now).changes === 1
    );
  }

  finishAction(id: string, state: ActionState, result: string | null): void {
    if (state === "pending" || state === "running")
      throw new Error("Cannot finish an action with a nonterminal state");
    this.db
      .query(
        "UPDATE actions SET state = ?, result = ?, completed_at = ? WHERE id = ? AND state IN ('pending','running','uncertain')",
      )
      .run(state, result, Date.now(), id);
  }

  setActionResult(id: string, result: string): void {
    this.db
      .query("UPDATE actions SET result=? WHERE id=? AND state='running'")
      .run(result, id);
  }

  listInterruptedActions(): Action[] {
    return this.db
      .query<ActionRow, []>(
        "SELECT * FROM actions WHERE state = 'running' ORDER BY created_at",
      )
      .all()
      .map(action);
  }

  expireActions(now = Date.now()): number {
    return this.db
      .query(
        "UPDATE actions SET state = 'expired', completed_at = ? WHERE state = 'pending' AND confirm_until <= ?",
      )
      .run(now, now).changes;
  }

  listActions(
    targetId: string,
    guildId: string,
    limit = 10,
    offset = 0,
  ): Action[] {
    return this.db
      .query<ActionRow, [string, string, number, number]>(
        "SELECT * FROM actions WHERE target_id = ? AND guild_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
      )
      .all(
        targetId,
        guildId,
        Math.max(1, Math.min(100, Math.trunc(limit))),
        Math.max(0, Math.trunc(offset)),
      )
      .map(action);
  }

  setSanction(sanction: Sanction): void {
    this.db
      .query(
        `INSERT INTO sanctions(guild_id,target_id,kind,action_id,expires_at,role_id) VALUES(?,?,?,?,?,?)
            ON CONFLICT(guild_id,target_id,kind) DO UPDATE SET action_id=excluded.action_id,expires_at=excluded.expires_at,role_id=excluded.role_id`,
      )
      .run(
        sanction.guildId,
        sanction.targetId,
        sanction.kind,
        sanction.actionId,
        sanction.expiresAt,
        sanction.roleId,
      );
  }

  getSanction(
    guildId: string,
    targetId: string,
    kind: Sanction["kind"],
  ): Sanction | null {
    return this.db
      .query<Sanction, [string, string, string]>(
        `SELECT guild_id AS guildId,target_id AS targetId,
            kind,action_id AS actionId,expires_at AS expiresAt,role_id AS roleId FROM sanctions
            WHERE guild_id=? AND target_id=? AND kind=?`,
      )
      .get(guildId, targetId, kind);
  }

  listSanctions(): Sanction[] {
    return this.db
      .query<Sanction, []>(
        `SELECT guild_id AS guildId,target_id AS targetId,
            kind,action_id AS actionId,expires_at AS expiresAt,role_id AS roleId FROM sanctions`,
      )
      .all();
  }

  removeSanction(
    guildId: string,
    targetId: string,
    kind: Sanction["kind"],
    actionId?: string,
  ): void {
    if (actionId)
      this.db
        .query(
          "DELETE FROM sanctions WHERE guild_id=? AND target_id=? AND kind=? AND action_id=?",
        )
        .run(guildId, targetId, kind, actionId);
    else
      this.db
        .query(
          "DELETE FROM sanctions WHERE guild_id=? AND target_id=? AND kind=?",
        )
        .run(guildId, targetId, kind);
  }

  createReport(input: ReportInput): Report {
    const inserted =
      this.db
        .query(
          "INSERT INTO reports(id,interaction_id,payload) VALUES(?,?,?) ON CONFLICT(interaction_id) DO NOTHING",
        )
        .run(
          input.id,
          input.interactionId,
          JSON.stringify(reportMetadata(input)),
        ).changes === 1;
    const row = this.db
      .query<ReportRow, [string]>(
        "SELECT * FROM reports WHERE interaction_id=?",
      )
      .get(input.interactionId);
    if (!row) throw new Error("Report was not persisted");
    if (inserted) this.cacheReportEvidence(input);
    return this.report(row);
  }

  getReport(id: string): Report | null {
    const row = this.db
      .query<ReportRow, [string]>("SELECT * FROM reports WHERE id=?")
      .get(id);
    return row ? this.report(row) : null;
  }

  claimReport(id: string): boolean {
    return (
      this.db
        .query(
          "UPDATE reports SET state='processing' WHERE id=? AND state='open'",
        )
        .run(id).changes === 1
    );
  }

  releaseReport(id: string): void {
    this.db
      .query(
        "UPDATE reports SET state='open' WHERE id=? AND state='processing'",
      )
      .run(id);
  }

  resolveReport(id: string, actorId: string, resolution: string): void {
    this.db
      .query(
        "UPDATE reports SET state='resolved',resolved_by=?,resolution=? WHERE id=? AND state IN ('open','processing')",
      )
      .run(actorId, resolution, id);
  }

  setReportMessage(id: string, messageId: string): void {
    this.db
      .query("UPDATE reports SET mod_message_id=? WHERE id=?")
      .run(messageId, id);
  }

  listOpenReports(): Report[] {
    return this.db
      .query<ReportRow, []>(
        "SELECT * FROM reports WHERE state IN ('open','processing') ORDER BY rowid",
      )
      .all()
      .map((row) => this.report(row));
  }

  enqueue(
    kind: OutboxItem["kind"],
    payload: Record<string, unknown>,
    id: string = crypto.randomUUID(),
  ): void {
    const inserted =
      this.db
        .query(
          "INSERT INTO outbox(id,kind,payload,next_attempt_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
        )
        .run(id, kind, JSON.stringify(outboxMetadata(payload)), Date.now())
        .changes === 1;
    if (inserted) {
      this.forgetOutboxPayload(id);
      try {
        const json = JSON.stringify(payload);
        const bytes = Buffer.byteLength(json, "utf8");
        if (bytes <= 16 * 1024 * 1024) {
          this.outboxPayloads.set(id, {
            json,
            bytes,
            expiresAt: Date.now() + 3_600_000,
          });
          this.outboxBytes += bytes;
        }
      } catch {
        /* Reference-only jobs remain recoverable without an in-memory body. */
      }
    }
    this.pruneOutboxPayloads();
  }

  dueOutbox(now = Date.now(), limit = 10): OutboxItem[] {
    this.pruneOutboxPayloads();
    const rows = this.db
      .query<
        {
          id: string;
          kind: OutboxItem["kind"];
          payload: string;
          attempts: number;
          nextAttemptAt: number;
        },
        [number, number]
      >(
        "SELECT id,kind,payload,attempts,next_attempt_at AS nextAttemptAt FROM outbox WHERE next_attempt_at <= ? ORDER BY next_attempt_at,rowid LIMIT ?",
      )
      .all(now, Math.max(1, Math.min(100, Math.trunc(limit))));
    return rows.map((row) => ({
      ...row,
      payload: object<Record<string, unknown>>(
        this.outboxPayloads.get(row.id)?.json ?? row.payload,
      ),
    }));
  }

  completeOutbox(id: string): void {
    this.db.query("DELETE FROM outbox WHERE id=?").run(id);
    this.forgetOutboxPayload(id);
  }

  retryOutbox(id: string, error: string, now = Date.now()): void {
    this.db
      .query(
        `UPDATE outbox SET next_attempt_at=? + MIN(3600000,5000 * (1 << MIN(attempts,10))),
            attempts=attempts+1,last_error=? WHERE id=?`,
      )
      .run(
        now,
        /^(?:\d{3,10}|network|offline|timeout|invalid|error)$/.test(error)
          ? error
          : "error",
        id,
      );
  }

  audit(event: string, data: Record<string, unknown>): void {
    if (!essentialAudit(event)) return;
    this.db
      .query("INSERT INTO audit(created_at,event,data) VALUES(?,?,?)")
      .run(Date.now(), event, JSON.stringify(auditMetadata(data)));
  }

  close(): void {
    this.reportEvidence.clear();
    this.outboxPayloads.clear();
    this.outboxBytes = 0;
    this.db.close(false);
  }
}
