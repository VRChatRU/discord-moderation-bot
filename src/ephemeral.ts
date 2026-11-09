import {
  MessageFlags,
  Routes,
  type Client,
  type Interaction,
} from "discord.js";
import type { Store } from "./store.ts";
import type { Logger } from "./types.ts";

export const ephemeralLifetime = 30_000;

interface ReplyRow {
  id: string;
  application_id: string;
  token: string;
  message_id: string | null;
  expires_at: number;
  token_expires_at: number;
  next_attempt_at: number;
  attempts: number;
  state: "active" | "deleted";
}

export class EphemeralExpired extends Error {
  constructor() {
    super("Срок ответа истёк.");
  }
}

function ephemeralOptions(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const options = value as { ephemeral?: boolean; flags?: unknown };
  if (options.ephemeral) return true;
  if (typeof options.flags === "number")
    return !!(options.flags & MessageFlags.Ephemeral);
  return !!(
    options.flags &&
    typeof options.flags === "object" &&
    "has" in options.flags &&
    typeof options.flags.has === "function" &&
    options.flags.has(MessageFlags.Ephemeral)
  );
}

export class EphemeralReplies {
  private readonly watched = new WeakSet<object>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private busy = false;

  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS ephemeral_replies (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, token TEXT NOT NULL, message_id TEXT,
      expires_at INTEGER NOT NULL, token_expires_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS ephemeral_due ON ephemeral_replies(state,next_attempt_at);
    CREATE INDEX IF NOT EXISTS ephemeral_message ON ephemeral_replies(message_id);`);
  }

  private async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.locks.set(id, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(id) === task) this.locks.delete(id);
    }
  }

  private get(id: string): ReplyRow | null {
    return this.store.db
      .query<ReplyRow, [string]>("SELECT * FROM ephemeral_replies WHERE id=?")
      .get(id);
  }

  /** Wrap only response methods; showing a modal never creates a deletion job. */
  watch(interaction: Interaction): void {
    if (!interaction.isRepliable() || this.watched.has(interaction)) return;
    this.watched.add(interaction);
    const applicationId =
      interaction.applicationId ?? this.client.application?.id;
    if (!applicationId || !interaction.token) return;
    const source = "message" in interaction ? interaction.message : null;
    const ownSource =
      !!source?.flags?.has(MessageFlags.Ephemeral) &&
      (source.applicationId === applicationId ||
        source.webhookId === applicationId ||
        source.author?.id === this.client.user?.id);
    let id: string | null = null;
    const sourceId = () => {
      if (!ownSource || !source) return null;
      const existing = this.store.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM ephemeral_replies WHERE message_id=? LIMIT 1",
        )
        .get(source.id);
      return existing?.id ?? source.interactionMetadata?.id ?? source.id;
    };
    const methods = interaction as unknown as Record<string, unknown>;
    for (const name of [
      "reply",
      "deferReply",
      "editReply",
      "deferUpdate",
      "update",
      "deleteReply",
    ] as const) {
      const original = methods[name];
      if (typeof original !== "function") continue;
      methods[name] = async (...args: unknown[]) => {
        const initial = name === "reply" || name === "deferReply";
        const target = initial
          ? ephemeralOptions(args[0])
            ? interaction.id
            : null
          : (id ?? sourceId());
        if (!target) return Reflect.apply(original, interaction, args);
        id = target;
        const remember = (
          current: ReplyRow | null,
          at = this.now(),
          messageId: string | null = current?.message_id ??
            (ownSource ? source!.id : null),
        ) => {
          this.store.db
            .query(
              `INSERT INTO ephemeral_replies(id,application_id,token,message_id,expires_at,token_expires_at,next_attempt_at)
              VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,message_id=COALESCE(excluded.message_id,ephemeral_replies.message_id),
              expires_at=excluded.expires_at,token_expires_at=excluded.token_expires_at,next_attempt_at=excluded.next_attempt_at,attempts=0,state='active'`,
            )
            .run(
              target,
              applicationId,
              interaction.token,
              messageId,
              at + ephemeralLifetime,
              (interaction.createdTimestamp ?? at) + 15 * 60_000,
              at + ephemeralLifetime,
            );
        };
        if (name === "deferUpdate") {
          const startedAt = this.now();
          if (
            (interaction.createdTimestamp ?? startedAt) + 15 * 60_000 <=
            startedAt
          )
            throw new EphemeralExpired();
          const before = this.get(target);
          const wasActive =
            !before ||
            (before.state === "active" && before.expires_at > startedAt);
          // A fresh button has three seconds to ACK, even while an older edit is still in flight.
          const result: unknown = await Reflect.apply(
            original,
            interaction,
            args,
          );
          const acknowledgedAt = this.now();
          await this.locked(target, async () => {
            const current = this.get(target);
            if (
              !wasActive ||
              (current &&
                (current.state === "deleted" ||
                  current.expires_at <= this.now()))
            )
              return;
            // Waiting for an older edit must not add time to this button's lifetime.
            remember(current, acknowledgedAt);
          });
          return result;
        }
        return this.locked(target, async () => {
          if (
            (interaction.createdTimestamp ?? this.now()) + 15 * 60_000 <=
            this.now()
          )
            throw new EphemeralExpired();
          const current = this.get(target);
          if (
            !initial &&
            current &&
            (current.state === "deleted" || current.expires_at <= this.now())
          ) {
            throw new EphemeralExpired();
          }
          // Persist intent before the request, so a lost response still gets cleaned up.
          if (initial || !current) remember(current);
          const result: unknown = await Reflect.apply(
            original,
            interaction,
            args,
          );
          if (name === "deleteReply") this.dismiss(target);
          else {
            const messageId =
              result &&
              typeof result === "object" &&
              "flags" in result &&
              "id" in result &&
              typeof result.id === "string"
                ? result.id
                : null;
            remember(
              current,
              this.now(),
              messageId ??
                current?.message_id ??
                (ownSource ? source!.id : null),
            );
          }
          return result;
        });
      };
    }
  }

  private dismiss(id: string): void {
    this.store.db
      .query("UPDATE ephemeral_replies SET state='deleted',token='' WHERE id=?")
      .run(id);
  }

  /** Adopt confirmations created before this cleanup worker existed. */
  adopt(id: string, token: string, expiresAt: number): void {
    const applicationId = this.client.application?.id;
    if (!applicationId || !token) return;
    if (
      this.store.db
        .query("SELECT 1 FROM ephemeral_replies WHERE token=?")
        .get(token)
    )
      return;
    const deadline = Math.min(expiresAt, this.now() + ephemeralLifetime);
    this.store.db
      .query(
        `INSERT OR IGNORE INTO ephemeral_replies(id,application_id,token,expires_at,token_expires_at,next_attempt_at)
      VALUES(?,?,?,?,?,?)`,
      )
      .run(
        id,
        applicationId,
        token,
        deadline,
        expiresAt + 13 * 60_000,
        deadline,
      );
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // Deleted replies only need a tombstone while their webhook could still edit them.
      this.store.db
        .query(
          "DELETE FROM ephemeral_replies WHERE state='deleted' AND token_expires_at<=?",
        )
        .run(this.now());
      const rows = this.store.db
        .query<ReplyRow, [number]>(
          "SELECT * FROM ephemeral_replies WHERE state='active' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 20",
        )
        .all(this.now());
      for (const row of rows)
        await this.locked(row.id, async () => {
          const current = this.get(row.id);
          if (
            !current ||
            current.state !== "active" ||
            current.expires_at > this.now() ||
            current.next_attempt_at > this.now()
          )
            return;
          if (current.token_expires_at <= this.now()) {
            this.dismiss(row.id);
            return;
          }
          try {
            await this.client.rest.delete(
              Routes.webhookMessage(
                current.application_id,
                current.token,
                "@original",
              ),
              { auth: false },
            );
            this.dismiss(row.id);
            this.store.audit("ephemeral_deleted", { responseId: row.id });
          } catch (error) {
            const status = Number(
              (error as { status?: unknown } | null)?.status,
            );
            const code = Number((error as { code?: unknown } | null)?.code);
            if (
              [401, 403, 404].includes(status) ||
              [10008, 10015, 10062, 50027].includes(code)
            ) {
              this.dismiss(row.id);
              return;
            }
            const attempts = current.attempts + 1;
            this.store.db
              .query(
                "UPDATE ephemeral_replies SET attempts=?,next_attempt_at=? WHERE id=?",
              )
              .run(
                attempts,
                this.now() +
                  Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)),
                row.id,
              );
            if (attempts === 1 || (attempts & (attempts - 1)) === 0)
              this.logger.warn("Ephemeral response deletion postponed", {
                responseId: row.id,
                attempts,
                status: Number.isFinite(status) ? status : null,
                code: Number.isFinite(code) ? code : null,
              });
          }
        });
    } finally {
      this.busy = false;
    }
  }
}
