import type { Database } from "bun:sqlite";

const outboxFields = new Set([
  "channelId",
  "targetId",
  "actorId",
  "actionId",
  "actionState",
  "reportId",
  "replacingMessageId",
  "template",
  "sanctionKind",
  "outcome",
  "sourceChannelId",
  "messageId",
  "count",
]);
const auditEvents = new Set([
  "moderation.attempt",
  "moderation.applied",
  "dm_sent",
  "dm_failed",
]);
const auditFields = new Set([
  "actionId",
  "roleId",
  "targetId",
  "notificationId",
  "code",
  "status",
  "retry",
]);
const reportFields = new Set([
  "id",
  "interactionId",
  "guildId",
  "channelId",
  "messageId",
  "targetId",
  "reporterId",
  "createdAt",
  "reason",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function json(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function metadata(
  value: unknown,
  allowed: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (!allowed.has(key)) continue;
    if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (typeof item === "boolean" && key === "retry") result[key] = item;
    else if (
      typeof item === "string" &&
      item.length <= 200 &&
      /^[A-Za-z0-9_:.-]+$/.test(item)
    )
      result[key] = item;
    else if (item === null) result[key] = null;
  }
  return result;
}

export function reportMetadata(value: unknown): Record<string, unknown> {
  const input = record(value);
  const safe = metadata(input, reportFields);
  // A report reason is moderation context, like a case reason; message bodies are never retained.
  safe.reason =
    typeof input.reason === "string" ? input.reason.slice(0, 1000) : null;
  return safe;
}

export const outboxMetadata = (value: unknown): Record<string, unknown> =>
  metadata(value, outboxFields);
export const auditMetadata = (value: unknown): Record<string, unknown> =>
  metadata(value, auditFields);
export const essentialAudit = (event: string): boolean =>
  auditEvents.has(event);

function legacyOutboxMetadata(
  db: Database,
  tables: Set<string>,
  id: string,
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const safe = outboxMetadata(payload);
  if (safe.template) return safe;
  const findAction = (actionId: string) =>
    tables.has("actions")
      ? db
          .query<{ payload: string; state: string }, [string]>(
            "SELECT payload,state FROM actions WHERE id=?",
          )
          .get(actionId)
      : null;
  const match =
    /^(appeal-invite|expiry-dm|dm|action-log|appeal-log):(.+)$/.exec(id);
  if (match) {
    const prefix = match[1]!;
    const actionId = match[2]!;
    const action = findAction(actionId);
    const input = action ? json(action.payload) : {};
    if (kind === "dm" && ["appeal-invite", "expiry-dm"].includes(prefix)) {
      return outboxMetadata({
        ...safe,
        template: "unban",
        ...(action ? { actionId } : {}),
        targetId: safe.targetId ?? input.targetId,
      });
    }
    if (kind === "dm" && prefix === "dm" && action) {
      return outboxMetadata({
        ...safe,
        template: "action-dm",
        actionId,
        targetId: safe.targetId ?? input.targetId,
      });
    }
    if (
      kind === "log" &&
      ["action-log", "appeal-log"].includes(prefix) &&
      action
    ) {
      return outboxMetadata({
        ...safe,
        template: "action-log",
        actionId,
        actionState: safe.actionState ?? action.state,
      });
    }
  }
  if (kind === "log" && id.startsWith("dm-warning:") && tables.has("audit")) {
    const notificationId = id.slice("dm-warning:".length);
    const receipt = db
      .query<{ data: string }, []>(
        "SELECT data FROM audit WHERE event='dm_failed' ORDER BY id DESC",
      )
      .all()
      .map((row) => json(row.data))
      .find((value) => value.notificationId === notificationId);
    if (receipt)
      return outboxMetadata({
        ...safe,
        template: "dm-failed",
        targetId: safe.targetId ?? receipt.targetId,
        actionId: safe.actionId ?? receipt.actionId,
      });
  }
  const embeds = Array.isArray(payload.embeds) ? payload.embeds : [];
  if (
    kind === "dm" &&
    embeds.some(
      (embed: unknown) =>
        record(embed).description ===
        "Предыдущее уведомление отменено: действие не выполнено.",
    )
  ) {
    return outboxMetadata({ ...safe, template: "action-cancelled" });
  }
  return safe;
}

export function migrateStorage(db: Database): void {
  const version = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!.user_version;
  if (version >= 2) return;
  const tables = new Set(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      )
      .all()
      .map((row) => row.name),
  );
  if (
    tables.has("runtime_lease") &&
    db
      .query("SELECT 1 FROM runtime_lease WHERE expires_at>? LIMIT 1")
      .get(Date.now())
  ) {
    throw new Error(
      "Storage privacy migration requires stopping the running bot first (active runtime lease).",
    );
  }
  db.exec("PRAGMA secure_delete=ON");
  db.transaction(() => {
    for (const name of ["message_versions", "messages", "report_drafts"]) {
      if (tables.has(name)) db.exec(`DROP TABLE ${name}`);
    }
    if (tables.has("text_log_events")) {
      const columns = new Set(
        db
          .query<{ name: string }, []>("PRAGMA table_info(text_log_events)")
          .all()
          .map((row) => row.name),
      );
      db.exec(
        "CREATE TABLE privacy_text_log_events(id TEXT PRIMARY KEY,kind TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL)",
      );
      if (["id", "kind", "created_at"].every((key) => columns.has(key))) {
        db.exec(
          `INSERT OR IGNORE INTO privacy_text_log_events SELECT id,kind,${columns.has("message_id") ? "message_id" : "NULL"},created_at FROM text_log_events`,
        );
      }
      db.exec(
        "DROP TABLE text_log_events; ALTER TABLE privacy_text_log_events RENAME TO text_log_events",
      );
    }
    if (tables.has("text_log_pending_edits")) {
      const columns = new Set(
        db
          .query<{ name: string }, []>(
            "PRAGMA table_info(text_log_pending_edits)",
          )
          .all()
          .map((row) => row.name),
      );
      db.exec(
        "CREATE TABLE privacy_pending_edits(message_id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,version TEXT NOT NULL DEFAULT '')",
      );
      if (columns.has("message_id") && columns.has("channel_id")) {
        db.exec(
          `INSERT OR IGNORE INTO privacy_pending_edits SELECT message_id,channel_id,${columns.has("attempts") ? "attempts" : "0"},${columns.has("next_attempt_at") ? "next_attempt_at" : "0"},${columns.has("version") ? "version" : "''"} FROM text_log_pending_edits`,
        );
      }
      db.exec(
        "DROP TABLE text_log_pending_edits; ALTER TABLE privacy_pending_edits RENAME TO text_log_pending_edits",
      );
    }
    if (tables.has("reports")) {
      for (const row of db
        .query<{ id: string; interaction_id: string; payload: string }, []>(
          "SELECT id,interaction_id,payload FROM reports",
        )
        .all()) {
        db.query("UPDATE reports SET payload=? WHERE id=?").run(
          JSON.stringify(
            reportMetadata({
              ...json(row.payload),
              id: row.id,
              interactionId: row.interaction_id,
            }),
          ),
          row.id,
        );
      }
    }
    if (tables.has("outbox")) {
      for (const row of db
        .query<{ id: string; kind: string; payload: string }, []>(
          "SELECT id,kind,payload FROM outbox",
        )
        .all()) {
        db.query("UPDATE outbox SET payload=? WHERE id=?").run(
          JSON.stringify(
            legacyOutboxMetadata(
              db,
              tables,
              row.id,
              row.kind,
              json(row.payload),
            ),
          ),
          row.id,
        );
      }
      const columns = db
        .query<{ name: string }, []>("PRAGMA table_info(outbox)")
        .all();
      if (columns.some((column) => column.name === "last_error"))
        db.exec("UPDATE outbox SET last_error=NULL");
    }
    if (tables.has("audit")) {
      for (const row of db
        .query<{ id: number; event: string; data: string }, []>(
          "SELECT id,event,data FROM audit",
        )
        .all()) {
        if (!essentialAudit(row.event))
          db.query("DELETE FROM audit WHERE id=?").run(row.id);
        else
          db.query("UPDATE audit SET data=? WHERE id=?").run(
            JSON.stringify(auditMetadata(json(row.data))),
            row.id,
          );
      }
    }
  })();
  if (tables.size) {
    db.exec("VACUUM");
    const checkpoint = db
      .query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
      .get();
    if (checkpoint?.busy)
      throw new Error(
        "Storage privacy cleanup needs exclusive database access; stop other database readers and retry.",
      );
  }
  db.exec("PRAGMA user_version=2");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
