import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Collection,
  type Client,
  type GuildMember,
  type Message,
  type PartialMessage,
} from "discord.js";
import { Archive } from "../src/archive.ts";
import { loadConfig } from "../src/config.ts";
import { Notifications } from "../src/notifications.ts";
import { Store } from "../src/store.ts";
import { TextLog } from "../src/text-log.ts";
import type { Logger } from "../src/types.ts";

const stores = new Set<Store>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});
const config = loadConfig({
  DISCORD_TOKEN: "test",
  GUILD_ID: "666306330230915093",
  MUTE_ROLE_ID: "987396975743860766",
  KUMA_PUSH_URL: "https://example.com/push",
  SERVER_INVITE_URL: "https://vrcru.org/discord",
});
const channelId = "123456789012345678";
const userId = "123456789012345679";
const botId = "123456789012345680";
const messageId = "123456789012345681";
const logger: Logger = { info() {}, warn() {}, error() {}, async close() {} };

function message(
  content = "Original",
  changes: Record<string, unknown> = {},
): Message {
  return {
    id: messageId,
    channelId,
    guildId: config.guildId,
    partial: false,
    author: { id: userId, tag: "User42", bot: false },
    content,
    attachments: new Collection(),
    createdTimestamp: Date.UTC(2026, 10, 9, 10),
    ...changes,
  } as unknown as Message;
}

function partial(changes: Record<string, unknown> = {}): PartialMessage {
  return {
    id: messageId,
    channelId,
    guildId: config.guildId,
    partial: true,
    author: null,
    fetch: mock(async () => {
      throw new Error("Offline");
    }),
    ...changes,
  } as unknown as PartialMessage;
}

function attachments(...urls: string[]) {
  return new Collection(urls.map((url, index) => [String(index), { url }]));
}

function fixture(path = ":memory:") {
  const store = new Store(path);
  stores.add(store);
  const archive = new Archive(store);
  const fetchMessage = mock(async (_options: unknown) => message("Recovered"));
  const client = {
    user: { id: botId },
    isReady: () => true,
    channels: {
      fetch: mock(async () => ({
        isTextBased: () => true,
        messages: { fetch: fetchMessage },
      })),
    },
  } as unknown as Client;
  const notifications = new Notifications(client, store, config, logger);
  const textLog = new TextLog(
    client,
    store,
    archive,
    notifications,
    config,
    logger,
  );
  return { store, archive, client, fetchMessage, notifications, textLog };
}

const queued = (f: ReturnType<typeof fixture>) =>
  f.store.dueOutbox(Number.MAX_SAFE_INTEGER, 100);
const description = (f: ReturnType<typeof fixture>, index = 0) =>
  (queued(f)[index]!.payload.embeds as Array<{ description: string }>)[0]!
    .description;
const evidence = (f: ReturnType<typeof fixture>, index = 0) =>
  queued(f)[index]!.payload.evidence as
    { name: string; content: string } | undefined;

function persistentText(store: Store): string {
  const tables = store.db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  return JSON.stringify(
    tables.flatMap(({ name }) =>
      store.db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    ),
  );
}

describe("text event log", () => {
  test("keeps full before and after in RAM while SQLite retains only operational IDs", async () => {
    const f = fixture();
    const before = message(`${"Before ".repeat(1000)}BEFORE_END`);
    const after = message(`${"After ".repeat(1000)}AFTER_END`);
    f.archive.save(before);
    await f.textLog.updated(partial(), after);
    expect(queued(f)).toHaveLength(1);
    expect(queued(f)[0]!.payload.channelId).toBe(config.textLogChannelId);
    expect(description(f)).toContain("До:");
    expect(description(f)).toContain("После:");
    expect(description(f)).toContain(`**<@${userId}>**`);
    expect(description(f).length).toBeLessThanOrEqual(4096);
    expect(evidence(f)?.name).toBe(`text-log-${messageId}.txt`);
    expect(evidence(f)?.content).toContain(before.content);
    expect(evidence(f)?.content).toContain(after.content);
    expect(evidence(f)?.content).toContain("User42");
    expect(evidence(f)?.content).toContain("2026-11-09T10:00:00.000Z");
    expect(description(f)).toContain("Полный текст во вложении.");
    expect(f.archive.get(messageId)?.content).toBe(after.content);
    expect(f.archive.info(messageId)?.revision).toBe(1);
    const persisted = persistentText(f.store);
    expect(persisted).not.toContain("BEFORE_END");
    expect(persisted).not.toContain("AFTER_END");
    expect(persisted).not.toContain("User42");
    expect(
      f.store.db
        .query(
          "SELECT 1 FROM sqlite_master WHERE name IN ('messages','message_versions')",
        )
        .get(),
    ).toBeNull();
    expect(
      f.store.db
        .query<{ name: string }, []>("PRAGMA table_info(text_log_events)")
        .all()
        .map((column) => column.name)
        .sort(),
    ).toEqual(["created_at", "id", "kind", "message_id"]);
  });

  test("uses the cached before snapshot when the archive has not seen the message", async () => {
    const f = fixture();
    await f.textLog.updated(message("Before cache"), message("After cache"));
    expect(description(f)).toContain("Before cache");
    expect(description(f)).toContain("After cache");
    expect(f.archive.get(messageId)?.content).toBe("After cache");
    expect(evidence(f)).toBeUndefined();
  });

  test("embed-only updates and refreshed Discord CDN signatures do not count as edits", async () => {
    const f = fixture();
    const original = message("Same text", {
      attachments: attachments(
        "https://cdn.discordapp.com/attachments/1/2/file.png?ex=1&is=2&hm=old",
      ),
    });
    const refreshed = message("Same text", {
      attachments: attachments(
        "https://cdn.discordapp.com/attachments/1/2/file.png?hm=new&is=4&ex=3",
      ),
      embeds: [{ title: "Unfurled" }],
    });
    f.archive.save(original);
    await f.textLog.updated(original, refreshed);
    expect(queued(f)).toHaveLength(0);
    expect(f.archive.get(messageId)?.attachments[0]).toContain("hm=new");
    await f.textLog.updated(
      refreshed,
      message("Same text", {
        attachments: attachments(
          "https://cdn.discordapp.com/attachments/1/3/other.png",
        ),
      }),
    );
    expect(queued(f)).toHaveLength(1);
    expect(description(f)).toContain("Вложение 1");
  });

  test("deduplicates repeated events across instances without suppressing later text reversions", async () => {
    const f = fixture();
    f.archive.save(message("A"));
    await f.textLog.updated(
      message("A"),
      message("B", { editedTimestamp: 1000 }),
    );
    for (const item of queued(f)) f.store.completeOutbox(item.id);
    const restarted = new TextLog(
      f.client,
      f.store,
      new Archive(f.store),
      f.notifications,
      config,
      logger,
    );
    await restarted.updated(
      message("A"),
      message("B", { editedTimestamp: 1000 }),
    );
    expect(queued(f)).toHaveLength(0);
    await restarted.updated(
      message("B"),
      message("A", { editedTimestamp: 2000 }),
    );
    await restarted.updated(
      message("A"),
      message("B", { editedTimestamp: 3000 }),
    );
    expect(queued(f)).toHaveLength(2);
    expect(
      f.store.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM text_log_events WHERE kind='edited'",
        )
        .get()?.count,
    ).toBe(3);
  });

  test("archive changes and event claims roll back when the outbox write fails", async () => {
    const f = fixture();
    f.archive.save(message("A"));
    f.store.db.exec(
      "CREATE TRIGGER reject_text_queue BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'queue failure'); END",
    );
    await expect(f.textLog.updated(message("A"), message("B"))).rejects.toThrow(
      "queue failure",
    );
    expect(f.archive.get(messageId)?.content).toBe("A");
    expect(f.store.db.query("SELECT 1 FROM text_log_events").get()).toBeNull();
    f.store.db.exec("DROP TRIGGER reject_text_queue");
    await f.textLog.updated(message("A"), message("B"));
    expect(queued(f)).toHaveLength(1);
  });

  test("partial deletion uses saved evidence and never tries fetching a deleted message", async () => {
    const f = fixture();
    f.archive.save(
      message("Saved evidence", {
        attachments: attachments("https://example.com/evidence.png"),
      }),
    );
    const deleted = partial();
    await f.textLog.deleted(deleted);
    expect(description(f)).toContain("Saved evidence");
    expect(description(f)).toContain("https://example.com/evidence.png");
    expect(evidence(f)?.content).toContain("https://example.com/evidence.png");
    expect(evidence(f)?.content).toContain("Saved evidence");
    expect(description(f)).toContain(messageId);
    expect(deleted.fetch).not.toHaveBeenCalled();
    for (const item of queued(f)) f.store.completeOutbox(item.id);
    await new TextLog(
      f.client,
      f.store,
      f.archive,
      f.notifications,
      config,
      logger,
    ).deleted(deleted);
    expect(queued(f)).toHaveLength(0);
  });

  test("uncached partial deletions report unavailable text without inventing authors", async () => {
    const f = fixture();
    await f.textLog.deleted(partial());
    expect(description(f)).toContain("Текст не сохранён.");
    expect(description(f)).toContain(channelId);
    expect(description(f)).not.toContain("<@");
    expect(description(f)).not.toContain("undefined");
  });

  test("bulk deletion stores every event and sends one bounded summary", async () => {
    const f = fixture();
    const messages = new Collection<string, Message>();
    for (let index = 0; index < 100; index++) {
      const item = message(`Message ${index} ${"x".repeat(300)}`, {
        id: String(BigInt(messageId) + BigInt(index)),
        attachments: attachments(`https://example.com/evidence-${index}.png`),
      });
      messages.set(item.id, item);
      f.archive.save(item);
    }
    await f.textLog.bulkDeleted(messages, channelId, config.guildId);
    expect(queued(f)).toHaveLength(1);
    expect(description(f)).toContain("**100**");
    expect(description(f).length).toBeLessThanOrEqual(4096);
    expect(evidence(f)?.name).toMatch(/^text-log-[a-f0-9]{64}\.txt$/);
    for (const item of messages.values()) {
      expect(evidence(f)?.content).toContain(item.content);
      expect(evidence(f)?.content).toContain(item.id);
      expect(evidence(f)?.content).toContain(item.attachments.first()!.url);
    }
    expect(
      [...messages.keys()].filter(
        (id) => f.archive.info(id)?.deleted_at != null,
      ),
    ).toHaveLength(100);
    expect(persistentText(f.store)).not.toContain("evidence-0.png");
    expect(persistentText(f.store)).not.toContain("Message 0 ");
    await f.textLog.bulkDeleted(messages, channelId, config.guildId);
    await f.textLog.deleted(messages.first()!);
    expect(queued(f)).toHaveLength(1);
  });

  test("long deletions and removed attachment evidence are delivered in complete text files", async () => {
    const f = fixture();
    const content = `${"*long* ".repeat(700)}FULL_END`;
    const source = message(content, {
      attachments: attachments(
        "https://example.com/full-evidence.png?complete=true",
      ),
    });
    f.archive.save(source);
    await f.textLog.deleted(partial());
    expect(evidence(f)?.name).toBe(`text-log-${messageId}.txt`);
    expect(evidence(f)?.content).toContain(content);
    expect(evidence(f)?.content).toContain(
      "https://example.com/full-evidence.png?complete=true",
    );
    expect(description(f).length).toBeLessThanOrEqual(4096);
    expect(description(f)).toContain("Полный текст во вложении.");
  });

  test("bulk deletion accepts uncached partial messages using the trusted guild hint, while rejecting foreign guilds and DMs", async () => {
    const f = fixture();
    const messages = [
      partial({ guildId: null }),
      partial({ id: "foreign-id", guildId: "foreign" }),
      message("DM", { id: "dm-id", guildId: null }),
      partial({ id: "other-channel", channelId: "other", guildId: null }),
    ];
    await f.textLog.bulkDeleted(messages, channelId, config.guildId);
    expect(queued(f)).toHaveLength(1);
    expect(description(f)).toContain("**1**");
    expect(description(f)).toContain("Текст не сохранён.");
    expect(
      f.store.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM text_log_events",
        )
        .get()?.count,
    ).toBe(1);
  });

  test("ignores DMs, foreign guilds and bot output in text-log while retaining other bots elsewhere", async () => {
    const f = fixture();
    for (const changes of [
      { guildId: null },
      { guildId: "foreign" },
      {
        channelId: config.textLogChannelId,
        author: { id: botId, tag: "Bot", bot: true },
      },
    ]) {
      await f.textLog.updated(message("A", changes), message("B", changes));
      await f.textLog.deleted(message("A", changes));
    }
    const otherBot = message("Bot output", {
      channelId: config.textLogChannelId,
      author: { id: "other-bot", tag: "OtherBot", bot: true },
    });
    f.archive.save(otherBot);
    await f.textLog.deleted(partial({ channelId: config.textLogChannelId }));
    expect(queued(f)).toHaveLength(0);
    await f.textLog.deleted(
      message("Bot elsewhere", {
        author: { id: "other-bot", tag: "OtherBot", bot: true },
      }),
    );
    expect(queued(f)).toHaveLength(1);
  });

  test("a cached partial guild ID can be recovered from the archive", async () => {
    const f = fixture();
    f.archive.save(message("Saved"));
    await f.textLog.deleted(partial({ guildId: null }));
    expect(description(f)).toContain("Saved");
  });

  test("departure deduplication is scoped to the member's join incarnation", async () => {
    const f = fixture();
    const member = {
      id: userId,
      guild: { id: config.guildId },
      nickname: "Nickname",
      joinedTimestamp: Date.now() - 86_400_000,
    } as GuildMember;
    await f.textLog.memberLeft(member);
    await f.textLog.memberLeft(member);
    expect(queued(f)).toHaveLength(1);
    expect(description(f)).toContain("**Nickname**");
    await f.textLog.memberLeft({
      ...member,
      joinedTimestamp: member.joinedTimestamp! + 1000,
    } as GuildMember);
    expect(queued(f)).toHaveLength(2);
  });

  test("a failed deletion notification does not mark the RAM snapshot deleted before commit", async () => {
    const f = fixture();
    f.archive.save(message("DELETION_SENTINEL"));
    f.store.db.exec(
      "CREATE TRIGGER reject_text_delete BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'queue failure'); END",
    );
    await expect(f.textLog.deleted(partial())).rejects.toThrow("queue failure");
    expect(f.archive.info(messageId)?.deleted_at).toBeNull();
    expect(f.store.db.query("SELECT 1 FROM text_log_events").get()).toBeNull();
    f.store.db.exec("DROP TRIGGER reject_text_delete");
    await f.textLog.deleted(partial());
    expect(f.archive.info(messageId)?.deleted_at).not.toBeNull();
    expect(queued(f)).toHaveLength(1);
    expect(persistentText(f.store)).not.toContain("DELETION_SENTINEL");
  });

  test("unknown-author events in the internal text log cannot create logging loops", async () => {
    const f = fixture();
    await f.textLog.deleted(partial({ channelId: config.textLogChannelId }));
    expect(queued(f)).toHaveLength(0);
  });

  test("unknown join timestamps still deduplicate departures after worker restart", async () => {
    const f = fixture();
    const member = {
      id: userId,
      guild: { id: config.guildId },
      joinedTimestamp: null,
      nickname: "NICKNAME_SENTINEL",
    } as unknown as GuildMember;
    await f.textLog.memberLeft(member);
    await new TextLog(
      f.client,
      f.store,
      new Archive(),
      f.notifications,
      config,
      logger,
    ).memberLeft(member);
    expect(queued(f)).toHaveLength(1);
    expect(persistentText(f.store)).not.toContain("NICKNAME_SENTINEL");
    await f.textLog.memberLeft({
      ...member,
      joinedTimestamp: Date.now() + 1000,
    } as GuildMember);
    expect(queued(f)).toHaveLength(2);
  });

  test("tick removes expired operational deduplication IDs after seven days", async () => {
    const f = fixture();
    f.store.db
      .query(
        "INSERT INTO text_log_events(id,kind,message_id,created_at) VALUES('old','deleted','old-message',?)",
      )
      .run(Date.now() - 7 * 86_400_000 - 1);
    f.store.db
      .query(
        "INSERT INTO text_log_events(id,kind,message_id,created_at) VALUES('fresh','deleted','fresh-message',?)",
      )
      .run(Date.now());
    await f.textLog.tick();
    expect(
      f.store.db.query("SELECT 1 FROM text_log_events WHERE id='old'").get(),
    ).toBeNull();
    expect(
      f.store.db.query("SELECT 1 FROM text_log_events WHERE id='fresh'").get(),
    ).not.toBeNull();
  });
});

describe("partial edit recovery", () => {
  test("persists only a retry reference and reports unavailable old text after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "discord-text-log-"));
    const path = join(dir, "app.db");
    let f = fixture(path);
    try {
      await f.textLog.updated(message("Before offline"), partial());
      expect(f.archive.get(messageId)?.content).toBe("Before offline");
      expect(queued(f)).toHaveLength(0);
      expect(persistentText(f.store)).not.toContain("Before offline");
      expect(
        f.store.db
          .query<{ name: string }, []>(
            "PRAGMA table_info(text_log_pending_edits)",
          )
          .all()
          .map((column) => column.name),
      ).not.toContain("before_snapshot");
      f.store.close();
      stores.delete(f.store);
      f = fixture(path);
      f.store.db
        .query("UPDATE text_log_pending_edits SET next_attempt_at=0")
        .run();
      await f.textLog.tick();
      expect(description(f)).not.toContain("Before offline");
      expect(description(f)).toContain("Текст не сохранён.");
      expect(description(f)).toContain("Recovered");
      expect(f.fetchMessage).toHaveBeenCalledWith({
        message: messageId,
        force: true,
      });
      expect(
        f.store.db.query("SELECT 1 FROM text_log_pending_edits").get(),
      ).toBeNull();
    } finally {
      f.store.close();
      stores.delete(f.store);
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(dir);
    }
  });

  test("a late edit fetch cannot resurrect or log a message that was deleted meanwhile", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<Message>();
    const pending = partial({ fetch: mock(async () => gate.promise) });
    const updating = f.textLog.updated(message("Before"), pending);
    await f.textLog.deleted(pending);
    gate.resolve(message("After"));
    await updating;
    expect(queued(f)).toHaveLength(1);
    expect(description(f)).toContain("Удалено сообщение");
    expect(f.archive.get(messageId)?.content).toBe("Before");
  });

  test("an older partial fetch cannot overwrite a newer edit recovery", async () => {
    const f = fixture();
    const firstGate = Promise.withResolvers<Message>();
    const secondGate = Promise.withResolvers<Message>();
    const first = f.textLog.updated(
      message("A"),
      partial({ fetch: mock(async () => firstGate.promise) }),
    );
    const second = f.textLog.updated(
      partial(),
      partial({ fetch: mock(async () => secondGate.promise) }),
    );
    firstGate.resolve(message("B"));
    await first;
    expect(queued(f)).toHaveLength(0);
    secondGate.resolve(message("C"));
    await second;
    expect(f.archive.get(messageId)?.content).toBe("C");
    expect(queued(f)).toHaveLength(1);
    expect(description(f)).toContain("**A**");
    expect(description(f)).toContain("**C**");
  });

  test("a permanently unavailable edited message keeps old evidence and reports the missing new text", async () => {
    const f = fixture();
    await f.textLog.updated(
      message("Old evidence"),
      partial({
        fetch: mock(async () => {
          throw { code: 10008, status: 404 };
        }),
      }),
    );
    expect(f.archive.get(messageId)?.content).toBe("Old evidence");
    expect(description(f)).toContain("Новый текст недоступен");
    expect(
      f.store.db.query("SELECT 1 FROM text_log_pending_edits").get(),
    ).toBeNull();
  });
});
