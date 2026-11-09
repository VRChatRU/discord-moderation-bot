import type { APIMessage, Message, PartialMessage } from "discord.js";
import type { Store } from "./store.ts";
import type { MessageSnapshot } from "./types.ts";

export function snapshot(message: Message | APIMessage): MessageSnapshot {
  if ("channelId" in message) {
    return {
      id: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
      authorName: message.author.tag,
      content: message.content,
      attachments: [...message.attachments.values()].map(
        (attachment) => attachment.url,
      ),
      createdAt: message.createdTimestamp,
    };
  }
  return {
    id: message.id,
    channelId: message.channel_id,
    authorId: message.author.id,
    authorName: message.author.username,
    content: message.content,
    attachments: message.attachments.map((attachment) => attachment.url),
    createdAt: Date.parse(message.timestamp),
  };
}

export interface ArchiveInfo {
  guild_id: string | null;
  deleted_at: number | null;
  author_bot: number | null;
  revision: number;
}

interface Entry {
  snapshot: MessageSnapshot;
  signature: string;
  info: ArchiveInfo;
  expiresAt: number;
}
interface Options {
  capacity?: number;
  ttlMs?: number;
  now?: () => number;
}
const copy = (value: MessageSnapshot): MessageSnapshot => ({
  ...value,
  attachments: [...value.attachments],
});

/** A bounded cache for partial Discord events. Chat content never reaches SQLite. */
export class Archive {
  private readonly messages = new Map<string, Entry>();
  private readonly capacity: number;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(_store?: Store, options: Options = {}) {
    this.capacity = Number.isFinite(options.capacity)
      ? Math.max(1, Math.min(1000, Math.trunc(options.capacity!)))
      : 1000;
    this.ttl = Number.isFinite(options.ttlMs)
      ? Math.max(1, Math.min(3_600_000, options.ttlMs!))
      : 3_600_000;
    this.now = options.now ?? Date.now;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.messages)
      if (entry.expiresAt <= now) this.messages.delete(id);
    while (this.messages.size > this.capacity)
      this.messages.delete(this.messages.keys().next().value!);
  }

  save(message: Message | PartialMessage): void {
    if (message.partial) return;
    this.saveSnapshot(snapshot(message as Message), message.guildId);
    const entry = this.messages.get(message.id);
    if (entry) entry.info.author_bot = message.author.bot ? 1 : 0;
  }

  saveSnapshot(data: MessageSnapshot, guildId: string | null): void {
    this.prune();
    const previous = this.messages.get(data.id);
    const signature = JSON.stringify(data);
    this.messages.delete(data.id);
    this.messages.set(data.id, {
      snapshot: copy(data),
      signature,
      expiresAt: this.now() + this.ttl,
      info: {
        guild_id: guildId,
        deleted_at: previous?.info.deleted_at ?? null,
        author_bot: previous?.info.author_bot ?? null,
        revision: previous
          ? previous.info.revision + Number(previous.signature !== signature)
          : 0,
      },
    });
    this.prune();
  }

  get(id: string): MessageSnapshot | null {
    this.prune();
    const entry = this.messages.get(id);
    return entry ? copy(entry.snapshot) : null;
  }

  info(id: string): ArchiveInfo | null {
    this.prune();
    const entry = this.messages.get(id);
    return entry ? { ...entry.info } : null;
  }

  deleted(id: string): void {
    this.prune();
    const entry = this.messages.get(id);
    if (entry && entry.info.deleted_at === null)
      entry.info.deleted_at = this.now();
  }

  private recentWhere(
    predicate: (entry: Entry) => boolean,
    limit: number,
  ): MessageSnapshot[] {
    this.prune();
    const count = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, Math.trunc(limit)))
      : 10;
    return [...this.messages.values()]
      .filter(predicate)
      .sort((a, b) => b.snapshot.createdAt - a.snapshot.createdAt)
      .slice(0, count)
      .map((entry) => copy(entry.snapshot));
  }

  recent(
    channelId: string,
    authorId: string | null,
    limit = 10,
  ): MessageSnapshot[] {
    return this.recentWhere(
      (entry) =>
        entry.snapshot.channelId === channelId &&
        (!authorId || entry.snapshot.authorId === authorId),
      limit,
    );
  }

  recentGuild(
    guildId: string,
    authorId: string,
    limit = 10,
  ): MessageSnapshot[] {
    return this.recentWhere(
      (entry) =>
        entry.info.guild_id === guildId && entry.snapshot.authorId === authorId,
      limit,
    );
  }
}
