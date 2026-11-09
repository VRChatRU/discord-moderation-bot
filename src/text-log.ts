import { createHash } from "node:crypto";
import {
  escapeMarkdown,
  type Client,
  type Collection,
  type GuildMember,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
} from "discord.js";
import { Archive, snapshot } from "./archive.ts";
import { errorCode, permanent, type Notifications } from "./notifications.ts";
import type { Store } from "./store.ts";
import type { Config, Logger, MessageSnapshot } from "./types.ts";
import { bold, clip, logNotice, userMention } from "./ui.ts";

type DiscordMessage = Message | PartialMessage;
interface PendingEdit {
  message_id: string;
  channel_id: string;
  attempts: number;
  version: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function attachmentIdentity(value: string): string {
  try {
    const url = new URL(value);
    if (
      ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) &&
      url.pathname.startsWith("/attachments/")
    ) {
      for (const key of ["ex", "is", "hm"]) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return value;
  }
}

function signature(value: MessageSnapshot): string {
  return digest(
    JSON.stringify({
      content: value.content.replaceAll("\r\n", "\n"),
      attachments: value.attachments.map(attachmentIdentity).sort(),
    }),
  );
}

function known(message: DiscordMessage): MessageSnapshot | null {
  return !message.partial && message.author
    ? snapshot(message as Message)
    : null;
}

function messageBody(message: MessageSnapshot | null, limit: number): string {
  if (!message) return "Текст не сохранён.";
  const content = message.content
    ? bold(
        clip(escapeMarkdown(message.content).replaceAll("\u0000", ""), limit),
      )
    : "Без текста.";
  const links: string[] = [];
  let available = 300;
  for (const [index, value] of message.attachments.entries()) {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      const link = `[**Вложение ${index + 1}**](<${url.href.replaceAll(">", "%3E")}>)`;
      if (link.length > available) continue;
      links.push(link);
      available -= link.length + 3;
    } catch {
      /* Invalid source URLs are omitted from the preview. */
    }
  }
  return `${content}${message.attachments.length ? `\nВложения: ${bold(String(message.attachments.length))}${links.length ? ` · ${links.join(" · ")}` : ""}` : ""}`;
}

function needsEvidence(
  message: MessageSnapshot | null,
  limit: number,
): boolean {
  return (
    !!message &&
    (escapeMarkdown(message.content).length > limit ||
      message.attachments.length > 0)
  );
}

function transcript(
  message: MessageSnapshot | null,
  guildId: string,
  channelId: string,
  messageId: string,
): string {
  return [
    `Сообщение: ${messageId}`,
    `Канал: ${channelId}`,
    `Ссылка: https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
    ...(message
      ? [
          `Автор: ${message.authorName} (${message.authorId})`,
          `Время (UTC): ${Number.isFinite(message.createdAt) ? new Date(message.createdAt).toISOString() : "Неизвестно"}`,
          "Вложения:",
          ...(message.attachments.length ? message.attachments : ["Нет"]),
          "Текст сообщения:",
          message.content,
        ]
      : ["Автор неизвестен. Текст не сохранён."]),
  ].join("\n");
}

export class TextLog {
  private busy = false;
  private readonly session = crypto.randomUUID();

  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly archive: Archive,
    private readonly notifications: Notifications,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS text_log_events (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, message_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS text_log_pending_edits (
        message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS text_log_pending_due ON text_log_pending_edits(next_attempt_at);
    `);
  }

  private record(id: string) {
    return this.archive.info(id);
  }

  private scoped(message: DiscordMessage, guildHint?: string | null): boolean {
    const record = this.record(message.id);
    const guildId =
      message.guildId ??
      (record ? record.guild_id : message.partial ? guildHint : undefined);
    if (guildId !== this.config.guildId) return false;
    const authorId =
      message.author?.id ?? this.archive.get(message.id)?.authorId;
    return !(
      message.channelId === this.config.textLogChannelId &&
      (message.author?.bot ||
        this.record(message.id)?.author_bot ||
        (!message.author && !authorId) ||
        authorId === this.client.user?.id)
    );
  }

  private link(channelId: string, messageId: string): string {
    return `https://discord.com/channels/${this.config.guildId}/${channelId}/${messageId}`;
  }

  private saveEvent(
    id: string,
    kind: string,
    messageId: string | null,
    metadata: { channelId?: string; userId?: string },
  ): boolean {
    const saved =
      this.store.db
        .query(
          "INSERT INTO text_log_events(id,kind,message_id,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
        )
        .run(id, kind, messageId, Date.now()).changes === 1;
    if (saved)
      this.store.audit(`text_log_${kind}`, {
        eventId: id,
        messageId,
        kind,
        ...(metadata.channelId ? { channelId: metadata.channelId } : {}),
        ...(metadata.userId ? { userId: metadata.userId } : {}),
      });
    return saved;
  }

  private edited(
    before: MessageSnapshot | null,
    after: MessageSnapshot,
    eventVersion?: string,
  ): void {
    if (
      this.record(after.id)?.deleted_at != null ||
      this.store.db
        .query("SELECT 1 FROM text_log_events WHERE id=?")
        .get(`delete:${after.id}`)
    ) {
      this.store.db
        .query("DELETE FROM text_log_pending_edits WHERE message_id=?")
        .run(after.id);
      return;
    }
    const saved = this.archive.get(after.id);
    const previous = saved ?? before;
    if (previous && signature(previous) === signature(after)) {
      this.store.db
        .query("DELETE FROM text_log_pending_edits WHERE message_id=?")
        .run(after.id);
      this.archive.saveSnapshot(after, this.config.guildId);
      return;
    }
    const revision = saved
      ? (this.archive.info(after.id)?.revision ?? 0) + 1
      : before
        ? 1
        : 0;
    const id = `edit:${after.id}:${eventVersion ?? `${this.session}:${revision}`}`;
    const evidence =
      needsEvidence(previous, 1150) || needsEvidence(after, 1150)
        ? {
            name: `text-log-${after.id}.txt`,
            content: `Изменение сообщения\n\nДо:\n${transcript(previous, this.config.guildId, after.channelId, after.id)}\n\nПосле:\n${transcript(after, this.config.guildId, after.channelId, after.id)}`,
          }
        : undefined;
    const description = `${userMention(after.authorId)} изменил сообщение в ${bold(`<#${after.channelId}>`)}.\n[**${after.id}**](${this.link(after.channelId, after.id)})\n\nДо:\n${messageBody(previous, 1150)}\n\nПосле:\n${messageBody(after, 1150)}`;
    const logged = this.store.db.transaction(() => {
      this.store.db
        .query("DELETE FROM text_log_pending_edits WHERE message_id=?")
        .run(after.id);
      if (
        !this.saveEvent(id, "edited", after.id, { channelId: after.channelId })
      )
        return false;
      this.notifications.textLog(
        logNotice(
          `${description}${evidence ? "\n\nПолный текст во вложении." : ""}`,
        ),
        `text:${id}`,
        evidence,
        {
          template: "text-log",
          outcome: "edited",
          targetId: after.authorId,
          sourceChannelId: after.channelId,
          messageId: after.id,
        },
      );
      return true;
    })();
    // RAM is updated only after the operational ledger/outbox transaction commits.
    if (!saved && before)
      this.archive.saveSnapshot(before, this.config.guildId);
    this.archive.saveSnapshot(after, this.config.guildId);
    if (logged)
      this.logger.info("Message edit recorded", {
        messageId: after.id,
        channelId: after.channelId,
      });
  }

  async updated(before: DiscordMessage, after: DiscordMessage): Promise<void> {
    if (!this.scoped(after)) return;
    const previous = this.archive.get(after.id) ?? known(before);
    const current = known(after);
    if (current) {
      this.edited(
        previous,
        current,
        typeof after.editedTimestamp === "number"
          ? `at:${after.editedTimestamp}`
          : undefined,
      );
      return;
    }
    const version = crypto.randomUUID();
    const pending = this.store.db.transaction(() => {
      if (
        this.record(after.id)?.deleted_at ||
        this.store.db
          .query("SELECT 1 FROM text_log_events WHERE id=?")
          .get(`delete:${after.id}`)
      )
        return false;
      if (!this.archive.get(after.id) && previous)
        this.archive.saveSnapshot(previous, this.config.guildId);
      const existing = this.store.db
        .query("SELECT 1 FROM text_log_pending_edits WHERE message_id=?")
        .get(after.id);
      this.store.db
        .query(
          `INSERT INTO text_log_pending_edits(message_id,channel_id,version)
        VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET version=excluded.version,next_attempt_at=0,attempts=0`,
        )
        .run(after.id, after.channelId, version);
      if (!existing)
        this.store.audit("text_log_edit_pending", {
          messageId: after.id,
          channelId: after.channelId,
        });
      return true;
    })();
    if (pending)
      await this.recover(
        {
          message_id: after.id,
          channel_id: after.channelId,
          attempts: 0,
          version,
        },
        after,
      );
  }

  async deleted(message: DiscordMessage): Promise<void> {
    if (!this.scoped(message)) return;
    const data = this.archive.get(message.id) ?? known(message);
    const logged = this.store.db.transaction(() => {
      if (
        !this.saveEvent(`delete:${message.id}`, "deleted", message.id, {
          channelId: message.channelId,
        })
      )
        return false;
      this.store.db
        .query("DELETE FROM text_log_pending_edits WHERE message_id=?")
        .run(message.id);
      const author = data ? `${userMention(data.authorId)} · ` : "";
      const time =
        data && Number.isFinite(data.createdAt)
          ? `\nОтправлено: ${bold(`<t:${Math.floor(data.createdAt / 1000)}:f>`)}.`
          : "";
      const evidence = needsEvidence(data, 2500)
        ? {
            name: `text-log-${message.id}.txt`,
            content: `Удаление сообщения\n\n${transcript(data, this.config.guildId, message.channelId, message.id)}`,
          }
        : undefined;
      this.notifications.textLog(
        logNotice(
          `${author}Удалено сообщение в ${bold(`<#${message.channelId}>`)}.\n[**${message.id}**](${this.link(message.channelId, message.id)})${time}\n\n${messageBody(data, 2500)}${evidence ? "\n\nПолный текст во вложении." : ""}`,
        ),
        `text:delete:${message.id}`,
        evidence,
        {
          template: "text-log",
          outcome: "deleted",
          targetId: data?.authorId,
          sourceChannelId: message.channelId,
          messageId: message.id,
        },
      );
      return true;
    })();
    if (!logged) return;
    if (data && !this.archive.get(message.id))
      this.archive.saveSnapshot(data, this.config.guildId);
    this.archive.deleted(message.id);
    this.logger.info("Message deletion recorded", {
      messageId: message.id,
      channelId: message.channelId,
    });
  }

  async bulkDeleted(
    messages: Collection<string, DiscordMessage> | Iterable<DiscordMessage>,
    channelId: string,
    guildId: string | null,
  ): Promise<void> {
    if (guildId !== this.config.guildId) return;
    const values: Iterable<DiscordMessage> =
      messages instanceof Map ? messages.values() : messages;
    const removed: Array<{ id: string; snapshot: MessageSnapshot | null }> = [];
    this.store.db.transaction(() => {
      for (const message of values) {
        if (message.channelId !== channelId || !this.scoped(message, guildId))
          continue;
        const data = this.archive.get(message.id) ?? known(message);
        if (
          !this.saveEvent(`delete:${message.id}`, "deleted", message.id, {
            channelId,
          })
        )
          continue;
        this.store.db
          .query("DELETE FROM text_log_pending_edits WHERE message_id=?")
          .run(message.id);
        removed.push({ id: message.id, snapshot: data });
      }
      if (!removed.length) return;
      const id = `bulk:${channelId}:${digest(
        removed
          .map((item) => item.id)
          .sort()
          .join(","),
      )}`;
      const evidence =
        removed.length > 8 ||
        removed.some((item) => needsEvidence(item.snapshot, 150))
          ? {
              name: `text-log-${digest(id)}.txt`,
              content: `Массовое удаление: ${removed.length} сообщений\n\n${removed.map((item, index) => `──────── ${index + 1} ────────\n${transcript(item.snapshot, this.config.guildId, channelId, item.id)}`).join("\n\n")}`,
            }
          : undefined;
      const snippets = removed
        .slice(0, 8)
        .map(
          (item) =>
            `${item.snapshot ? `${userMention(item.snapshot.authorId)} · ` : ""}[**${item.id}**](${this.link(channelId, item.id)})\n${item.snapshot?.content ? bold(clip(escapeMarkdown(item.snapshot.content), 150)) : item.snapshot ? "Без текста." : "Текст не сохранён."}`,
        )
        .join("\n\n");
      this.notifications.textLog(
        logNotice(
          `В ${bold(`<#${channelId}>`)} удалено ${bold(String(removed.length))} сообщений.\n\n${snippets}${removed.length > 8 ? `\n\nЕщё ${bold(String(removed.length - 8))} сообщений.` : ""}${evidence ? "\n\nПолный текст во вложении." : ""}`,
        ),
        `text:${id}`,
        evidence,
        {
          template: "text-log",
          outcome: "bulk",
          sourceChannelId: channelId,
          count: removed.length,
        },
      );
      this.store.audit("text_log_bulk_deleted", {
        channelId,
        messageIds: removed.map((item) => item.id),
      });
    })();
    for (const item of removed) {
      if (item.snapshot && !this.archive.get(item.id))
        this.archive.saveSnapshot(item.snapshot, this.config.guildId);
      this.archive.deleted(item.id);
    }
    if (removed.length)
      this.logger.info("Bulk message deletion recorded", {
        channelId,
        count: removed.length,
      });
  }

  async memberLeft(member: GuildMember | PartialGuildMember): Promise<void> {
    if (member.guild.id !== this.config.guildId) return;
    const prefix = `leave:${member.guild.id}:${member.id}:`;
    if (member.joinedTimestamp == null) {
      const recent = this.store.db
        .query<{ created_at: number }, [string]>(
          "SELECT created_at FROM text_log_events WHERE kind='member_left' AND id LIKE ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(`${prefix}%`);
      if (recent && Date.now() - recent.created_at < 30_000) return;
    }
    const id = `${prefix}${member.joinedTimestamp ?? crypto.randomUUID()}`;
    this.store.db.transaction(() => {
      if (
        !this.saveEvent(id, "member_left", null, {
          userId: member.id,
        })
      )
        return;
      const nickname = member.nickname
        ? `\nНик: ${bold(clip(escapeMarkdown(member.nickname), 200))}.`
        : "";
      const joined = member.joinedTimestamp
        ? `\nПрисоединился: ${bold(`<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`)}.`
        : "";
      this.notifications.textLog(
        logNotice(
          `${userMention(member.id)} покинул сервер.${nickname}${joined}`,
        ),
        `text:${id}`,
        undefined,
        { template: "text-log", outcome: "member-left", targetId: member.id },
      );
    })();
    this.logger.info("Member departure recorded", {
      userId: member.id,
      joinedAt: member.joinedTimestamp,
    });
  }

  private async recover(
    job: PendingEdit,
    partial?: DiscordMessage,
  ): Promise<void> {
    try {
      let message: DiscordMessage;
      if (partial?.fetch) message = await partial.fetch();
      else {
        const channel = await this.client.channels.fetch(job.channel_id);
        if (!channel?.isTextBased() || !("messages" in channel))
          throw { code: 10003, status: 404 };
        message = await channel.messages.fetch({
          message: job.message_id,
          force: true,
        });
      }
      const current = this.store.db
        .query<{ version: string }, [string]>(
          "SELECT version FROM text_log_pending_edits WHERE message_id=?",
        )
        .get(job.message_id);
      if (current?.version !== job.version) return;
      if (!this.scoped(message)) {
        this.store.db
          .query("DELETE FROM text_log_pending_edits WHERE message_id=?")
          .run(job.message_id);
        return;
      }
      const data = known(message);
      if (!data) throw new Error("Message remains partial");
      this.edited(
        this.archive.get(job.message_id),
        data,
        typeof message.editedTimestamp === "number"
          ? `at:${message.editedTimestamp}`
          : job.version,
      );
    } catch (error) {
      const current = this.store.db
        .query<{ version: string }, [string]>(
          "SELECT version FROM text_log_pending_edits WHERE message_id=?",
        )
        .get(job.message_id);
      if (current?.version !== job.version) return;
      if (permanent(error)) {
        this.store.db.transaction(() => {
          const id = `edit-unavailable:${job.message_id}:${job.version}`;
          if (
            this.saveEvent(id, "edit_unavailable", job.message_id, {
              channelId: job.channel_id,
            })
          ) {
            this.notifications.textLog(
              logNotice(
                `Не удалось проверить обновление сообщения [**${job.message_id}**](${this.link(job.channel_id, job.message_id)}) в ${bold(`<#${job.channel_id}>`)}.\nНовый текст недоступен.`,
              ),
              `text:${id}`,
              undefined,
              {
                template: "text-log",
                outcome: "edit-unavailable",
                sourceChannelId: job.channel_id,
                messageId: job.message_id,
              },
            );
          }
          this.store.db
            .query("DELETE FROM text_log_pending_edits WHERE message_id=?")
            .run(job.message_id);
        })();
        this.logger.warn("Edited message content unavailable", {
          messageId: job.message_id,
          code: errorCode(error),
        });
      } else {
        const attempts = job.attempts + 1;
        this.store.db
          .query(
            "UPDATE text_log_pending_edits SET attempts=?,next_attempt_at=? WHERE message_id=?",
          )
          .run(
            attempts,
            Date.now() +
              Math.min(3_600_000, 5_000 * 2 ** Math.min(attempts - 1, 10)),
            job.message_id,
          );
        if (attempts === 1 || (attempts & (attempts - 1)) === 0)
          this.logger.warn("Partial message edit recovery postponed", {
            messageId: job.message_id,
            attempts,
            code: errorCode(error),
          });
      }
    }
  }

  async tick(): Promise<void> {
    this.store.db
      .query("DELETE FROM text_log_events WHERE created_at<?")
      .run(Date.now() - 7 * 86_400_000);
    if (this.busy || !this.client.isReady()) return;
    this.busy = true;
    try {
      const jobs = this.store.db
        .query<PendingEdit, [number]>(
          "SELECT * FROM text_log_pending_edits WHERE next_attempt_at<=? ORDER BY next_attempt_at LIMIT 3",
        )
        .all(Date.now());
      for (const job of jobs) await this.recover(job);
    } finally {
      this.busy = false;
    }
  }
}
