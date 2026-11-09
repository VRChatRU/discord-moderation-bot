import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIEmbed, Client, Message } from "discord.js";
import { Appeals, isAppeal } from "../src/appeals.ts";
import { Archive } from "../src/archive.ts";
import { loadConfig } from "../src/config.ts";
import { Control } from "../src/control.ts";
import { caseMarker } from "../src/moderation.ts";
import { Notifications } from "../src/notifications.ts";
import { Store } from "../src/store.ts";
import {
  scamAppealPhrase,
  type ActionKind,
  type Logger,
  type MessageSnapshot,
  type ReportInput,
} from "../src/types.ts";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const config = loadConfig({
  DISCORD_TOKEN: "test",
  GUILD_ID: "666306330230915093",
  MUTE_ROLE_ID: "987396975743860766",
  KUMA_PUSH_URL: "https://kuma.invalid/api/push/test",
  SERVER_INVITE_URL: "https://vrcru.org/discord",
});
const logger: Logger = { info() {}, warn() {}, error() {}, async close() {} };
const userId = "123456789012345678";

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const control = new Control(store);
  const state: { ban: { reason: string } | null } = { ban: null };
  const unban = mock(async (_id: string) => {
    state.ban = null;
  });
  const guild = {
    bans: {
      fetch: mock(async () => {
        if (!state.ban) throw { code: 10026, status: 404 };
        return state.ban;
      }),
    },
    members: { unban },
  };
  const directMessages: unknown[] = [];
  const dmSend = mock(async (body: unknown) => {
    directMessages.push(body);
    return { id: "dm-id" };
  });
  const logSend = mock(async () => ({ id: "log-id" }));
  const client = {
    isReady: () => true,
    user: { id: "123456789012345679" },
    guilds: { fetch: mock(async () => guild), cache: new Map() },
    users: { fetch: mock(async (id: string) => ({ id, send: dmSend })) },
    rest: { post: logSend },
  } as unknown as Client;
  const notifications = new Notifications(client, store, config, logger);
  const appeals = new Appeals(
    client,
    store,
    control,
    notifications,
    config,
    logger,
  );
  return {
    store,
    control,
    state,
    unban,
    guild,
    client,
    notifications,
    appeals,
    directMessages,
    dmSend,
    logSend,
  };
}

function seedBan(
  f: ReturnType<typeof fixture>,
  kind: ActionKind = "scam",
  hoursAgo = 400,
) {
  const now = Date.now();
  const action = f.store.createAction({
    id: crypto.randomUUID(),
    interactionId: crypto.randomUUID(),
    guildId: config.guildId,
    actorId: "moderator",
    targetId: userId,
    channelId: config.modLogChannelId,
    kind,
    reason: null,
    durationDays: null,
    count: null,
    reportId: null,
    createdAt: now - hoursAgo * 3_600_000,
    confirmUntil: now + 60_000,
    messageIds: [],
  });
  f.store.finishAction(action.id, "succeeded", "Banned");
  f.store.db
    .query("UPDATE actions SET completed_at=? WHERE id=?")
    .run(now - hoursAgo * 3_600_000, action.id);
  f.store.setSanction({
    guildId: config.guildId,
    targetId: userId,
    kind: "ban",
    actionId: action.id,
    expiresAt: null,
    roleId: null,
  });
  f.state.ban = { reason: `Scam ${caseMarker(action.id)}` };
  return f.store.getAction(action.id)!;
}

const message = (content = scamAppealPhrase, id = "appeal-message") =>
  ({ id, content, author: { id: userId } }) as unknown as Message;
const appealRow = (store: Store) =>
  store.db
    .query<
      {
        state: string;
        action_id: string;
        next_attempt_at: number;
        attempts: number;
      },
      []
    >("SELECT * FROM appeals")
    .get();
const queuedText = (store: Store) =>
  JSON.stringify(store.dueOutbox(Number.MAX_SAFE_INTEGER, 100));

describe("scam recovery", () => {
  test("startup removes only obsolete appeal acknowledgments and preserves success invitations", () => {
    const f = fixture();
    const dm = (description: string) => ({
      targetId: userId,
      embeds: [{ description }],
    });
    const legacy = (id: string, description: string) =>
      f.store.db
        .query(
          "INSERT INTO outbox(id,kind,payload,next_attempt_at) VALUES(?,'dm',?,0)",
        )
        .run(id, JSON.stringify(dm(description)));
    f.store.enqueue("dm", dm("Проверяем блокировку…"), "appeal-reply:old");
    // Seed the old on-disk format explicitly; new enqueue never stores message bodies.
    legacy("legacy-early", "Напишите эту фразу <t:1800000000:R>.");
    legacy(
      "legacy-untracked",
      "Не удалось снять бан автоматически. Обратитесь к модератору.",
    );
    f.store.enqueue(
      "dm",
      dm("Автоматический разбан отменён. Обратитесь к модератору."),
      "appeal-cancelled:old",
    );
    f.store.enqueue(
      "dm",
      dm(`Бан снят. ${config.inviteUrl}`),
      "appeal-invite:success",
    );
    f.store.enqueue(
      "dm",
      dm("Вы получили предупреждение."),
      "ordinary-warning",
    );
    f.store.enqueue("log", dm("Проверяем блокировку…"), "moderator-log");
    // Malformed payloads belong to the notification validator, not this narrow migration.
    f.store.db
      .query(
        "INSERT INTO outbox(id,kind,payload,next_attempt_at) VALUES('malformed','dm','null',0)",
      )
      .run();
    new Appeals(f.client, f.store, f.control, f.notifications, config, logger);
    const rows = f.store.db
      .query<{ id: string }, []>("SELECT id FROM outbox ORDER BY id")
      .all();
    expect(rows.map((row) => row.id)).toEqual([
      "appeal-invite:success",
      "malformed",
      "moderator-log",
      "ordinary-warning",
    ]);
  });

  test("requires the full phrase while tolerating capitalization, whitespace, quotes and final punctuation", () => {
    expect(isAppeal(scamAppealPhrase)).toBe(true);
    expect(
      isAppeal(
        `  «${scamAppealPhrase.toLocaleUpperCase("ru").replaceAll(" ", "  \n")}».  `,
      ),
    ).toBe(true);
    expect(isAppeal(`"${scamAppealPhrase}."`)).toBe(true);
    expect(isAppeal(`${scamAppealPhrase}, пожалуйста`)).toBe(false);
    expect(
      isAppeal(scamAppealPhrase.replace("поменял пароль", "не поменял пароль")),
    ).toBe(false);
    expect(isAppeal("пустите меня обратно")).toBe(false);
  });

  test("rejects early requests without creating an automatic unban", async () => {
    const f = fixture();
    seedBan(f, "scam", 1);
    await f.appeals.receive(message());
    expect(appealRow(f.store)).toBeNull();
    expect(f.store.dueOutbox(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
    await f.appeals.tick();
    expect(f.unban).not.toHaveBeenCalled();
  });

  test("measures the waiting period from the persisted mutation attempt, not confirmation creation", async () => {
    const f = fixture();
    const action = seedBan(f);
    f.store.audit("moderation.attempt", { actionId: action.id });
    f.store.db
      .query("UPDATE audit SET created_at=? WHERE event='moderation.attempt'")
      .run(Date.now() - 3_600_000);
    await f.appeals.receive(message());
    expect(appealRow(f.store)).toBeNull();
    expect(f.store.dueOutbox(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  });

  test("recovery completion does not restart the waiting period for an old ban", async () => {
    const f = fixture();
    const action = seedBan(f);
    f.store.db
      .query("UPDATE actions SET completed_at=? WHERE id=?")
      .run(Date.now(), action.id);
    await f.appeals.receive(message());
    expect(appealRow(f.store)?.state).toBe("pending");
    await f.appeals.tick();
    expect(appealRow(f.store)?.state).toBe("done");
    expect(f.unban).toHaveBeenCalledTimes(1);
  });

  test("never automatically removes a regular ban or an untracked ban", async () => {
    const f = fixture();
    seedBan(f, "ban");
    await f.appeals.receive(message());
    expect(appealRow(f.store)).toBeNull();
    expect(f.store.dueOutbox(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
    f.store.removeSanction(config.guildId, userId, "ban");
    await f.appeals.receive(message(scamAppealPhrase, "untracked"));
    await f.appeals.tick();
    expect(f.unban).not.toHaveBeenCalled();
    expect(f.store.dueOutbox(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  });

  test("unbans an eligible owned scam case and durably sends exactly one invitation", async () => {
    const f = fixture();
    seedBan(f);
    await f.appeals.receive(message());
    await f.appeals.receive(message());
    expect(f.store.dueOutbox(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
    await f.appeals.tick();
    const row = appealRow(f.store)!;
    expect(row.state).toBe("done");
    expect(f.store.getAction(row.action_id)?.state).toBe("succeeded");
    expect(f.unban).toHaveBeenCalledTimes(1);
    expect(f.store.getSanction(config.guildId, userId, "ban")).toBeNull();
    expect(queuedText(f.store)).toContain(config.inviteUrl);
    const persistedInvite = JSON.parse(
      f.store.db
        .query<{ payload: string }, []>(
          "SELECT payload FROM outbox WHERE kind='dm'",
        )
        .get()!.payload,
    );
    expect(persistedInvite).toMatchObject({
      targetId: userId,
      actionId: row.action_id,
      template: "unban",
    });
    expect(persistedInvite).not.toHaveProperty("embeds");
    expect(JSON.stringify(persistedInvite)).not.toContain(config.inviteUrl);
    await f.appeals.tick();
    expect(f.unban).toHaveBeenCalledTimes(1);
    await f.notifications.tick();
    const inviteMessages = f.directMessages.filter((body) =>
      JSON.stringify(body).includes(config.inviteUrl),
    );
    expect(inviteMessages).toHaveLength(1);
    for (const payload of f.directMessages) {
      const embed = (payload as { embeds: APIEmbed[] }).embeds[0]!;
      expect(embed.title).toBe("Внимание!");
      expect(embed.color).toBe(15844379);
      expect(embed.footer).toEqual({
        text: "Модерация VRChatRU",
        icon_url: "https://i.imgur.com/72pQbbd.png",
      });
      expect(embed.fields).toBeUndefined();
      expect(embed.timestamp).toBeUndefined();
    }
    expect(f.store.dueOutbox(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  });

  test("preserves a moderator's replacement ban and cancels the queued appeal", async () => {
    const f = fixture();
    seedBan(f);
    await f.appeals.receive(message());
    f.state.ban = { reason: "Manual ban by another moderator" };
    await f.appeals.tick();
    const row = appealRow(f.store)!;
    expect(row.state).toBe("cancelled");
    expect(f.store.getAction(row.action_id)?.state).toBe("failed");
    expect(f.unban).not.toHaveBeenCalled();
    expect(queuedText(f.store)).not.toContain(config.inviteUrl);
    await f.appeals.receive(message(scamAppealPhrase, "second-appeal"));
    expect(
      f.store
        .dueOutbox(Number.MAX_SAFE_INTEGER)
        .filter((item) => item.kind === "dm"),
    ).toHaveLength(0);
  });

  test("does not unban when a newer tracked sanction supersedes the scam case", async () => {
    const f = fixture();
    seedBan(f);
    await f.appeals.receive(message());
    seedBan(f, "ban");
    await f.appeals.tick();
    expect(appealRow(f.store)?.state).toBe("cancelled");
    expect(f.unban).not.toHaveBeenCalled();
  });

  test("appeal cancellation and its moderator log commit together after a queue failure", async () => {
    const f = fixture();
    seedBan(f);
    await f.appeals.receive(message());
    f.state.ban = { reason: "Manual replacement ban" };
    f.store.db.exec(
      "CREATE TRIGGER reject_appeal_log BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'queue unavailable'); END",
    );
    await f.appeals.tick();
    const request = appealRow(f.store)!;
    expect(request.state).toBe("pending");
    expect(f.store.getAction(request.action_id)?.state).toBe("pending");
    expect(f.unban).not.toHaveBeenCalled();
    f.store.db.exec("DROP TRIGGER reject_appeal_log");
    f.store.db.query("UPDATE appeals SET next_attempt_at=0").run();
    await f.appeals.tick();
    expect(appealRow(f.store)?.state).toBe("cancelled");
    expect(f.store.getAction(request.action_id)?.state).toBe("failed");
    expect(
      f.store.dueOutbox().filter((item) => item.kind === "log"),
    ).toHaveLength(1);
    expect(
      f.store.dueOutbox().filter((item) => item.kind === "dm"),
    ).toHaveLength(0);
  });

  test("recovers an unban whose Discord response was lost without unbanning again", async () => {
    const f = fixture();
    seedBan(f);
    await f.appeals.receive(message());
    f.unban.mockImplementationOnce(async () => {
      f.state.ban = null;
      throw new Error("Response lost");
    });
    await f.appeals.tick();
    expect(appealRow(f.store)?.state).toBe("pending");
    expect(appealRow(f.store)?.attempts).toBe(1);
    expect(f.store.getAction(appealRow(f.store)!.action_id)?.state).toBe(
      "running",
    );
    expect(
      f.store
        .dueOutbox(Number.MAX_SAFE_INTEGER)
        .filter((item) => item.kind === "dm"),
    ).toHaveLength(0);
    f.store.db.query("UPDATE appeals SET next_attempt_at=0").run();
    const restarted = new Appeals(
      f.client,
      f.store,
      f.control,
      f.notifications,
      config,
      logger,
    );
    await restarted.tick();
    expect(appealRow(f.store)?.state).toBe("done");
    expect(f.unban).toHaveBeenCalledTimes(1);
    expect(queuedText(f.store)).toContain(config.inviteUrl);
  });

  test("does not execute a cancelled or expired automatic action", async () => {
    for (const state of ["cancelled", "expired"] as const) {
      const f = fixture();
      seedBan(f);
      await f.appeals.receive(message());
      f.store.finishAction(appealRow(f.store)!.action_id, state, "Stopped");
      await f.appeals.tick();
      expect(appealRow(f.store)?.state).toBe("cancelled");
      expect(f.unban).not.toHaveBeenCalled();
    }
  });

  test("does not execute when the atomic automatic-action claim has expired", async () => {
    const f = fixture();
    seedBan(f);
    await f.appeals.receive(message());
    f.store.db
      .query("UPDATE actions SET confirm_until=? WHERE id=?")
      .run(Date.now() - 1, appealRow(f.store)!.action_id);
    await f.appeals.tick();
    expect(appealRow(f.store)?.state).toBe("cancelled");
    expect(f.store.getAction(appealRow(f.store)!.action_id)?.state).toBe(
      "expired",
    );
    expect(f.unban).not.toHaveBeenCalled();
    expect(
      f.store
        .dueOutbox(Number.MAX_SAFE_INTEGER)
        .filter((item) => item.kind === "dm"),
    ).toHaveLength(0);
  });

  test("permission errors and pending retries never send a DM", async () => {
    const f = fixture();
    seedBan(f);
    await f.appeals.receive(message());
    f.unban.mockRejectedValue({ code: 50013, status: 403 });
    await f.appeals.tick();
    await f.appeals.receive(message(scamAppealPhrase, "pending-retry"));
    expect(appealRow(f.store)?.state).toBe("pending");
    expect(appealRow(f.store)?.attempts).toBe(1);
    expect(
      f.store
        .dueOutbox(Number.MAX_SAFE_INTEGER)
        .filter((item) => item.kind === "dm"),
    ).toHaveLength(0);
    await f.notifications.tick();
    expect(f.directMessages).toHaveLength(0);
  });
});

function draft(id = "draft"): ReportInput {
  return {
    id,
    interactionId: id,
    guildId: config.guildId,
    channelId: "channel",
    messageId: "message",
    targetId: userId,
    reporterId: "reporter",
    reason: null,
    message: sample("message"),
    context: [],
    createdAt: Date.now(),
  };
}

function sample(
  id: string,
  content = "Original",
  createdAt = 1000,
  channelId = "channel",
  authorId = userId,
): MessageSnapshot {
  return {
    id,
    channelId,
    authorId,
    authorName: "User",
    content,
    attachments: [],
    createdAt,
  };
}

describe("control", () => {
  test("serializes the same target, releases rejected locks, and lets other targets progress", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    const events: string[] = [];
    const first = f.control.locked("same", async () => {
      events.push("first");
      await gate.promise;
      events.push("first-finished");
      throw new Error("Failed operation");
    });
    const firstResult = first.catch(() => {});
    const second = f.control.locked("same", async () => {
      events.push("second");
    });
    await f.control.locked("different", async () => {
      events.push("different");
    });
    expect(events).toEqual(["first", "different"]);
    gate.resolve();
    await Promise.all([firstResult, second]);
    expect(events).toEqual(["first", "different", "first-finished", "second"]);
    await f.control.locked("same", async () => {
      events.push("third");
    });
    expect(events.at(-1)).toBe("third");
  });

  test("leases exclude another database connection until expiry and release is owner-bound", () => {
    const dir = mkdtempSync(join(tmpdir(), "discord-moderation-lease-"));
    const path = join(dir, "lease.db");
    const first = new Store(path);
    const second = new Store(path);
    try {
      const a = new Control(first);
      const b = new Control(second);
      expect(a.lease("a", 1000)).toBe(true);
      expect(b.lease("b", 1000)).toBe(false);
      b.releaseLease("b");
      expect(b.lease("b", 20_999)).toBe(false);
      expect(b.lease("b", 21_000)).toBe(true);
      expect(a.lease("a", 21_000)).toBe(false);
      a.releaseLease("a");
      expect(a.lease("a", 21_001)).toBe(false);
      b.releaseLease("b");
      expect(a.lease("a", 21_001)).toBe(true);
    } finally {
      first.close();
      second.close();
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(dir);
    }
  });

  test("report drafts require the owner and support only one submission before expiry", () => {
    const f = fixture();
    const input = draft();
    f.control.draft(input, Date.now() + 60_000);
    expect(f.control.getDraft(input.id, "other-user")).toBeNull();
    expect(
      f.control.updateDraft(
        { ...input, reporterId: "other-user" },
        Date.now() + 60_000,
      ),
    ).toBe(false);
    expect(
      f.control.updateDraft(
        { ...input, reason: "Reported" },
        Date.now() + 60_000,
      ),
    ).toBe(true);
    expect(f.control.updateDraft(input, Date.now() + 60_000)).toBe(false);
    expect(f.control.finishDraft(input.id, "other-user", "submitted")).toBe(
      false,
    );
    expect(f.control.finishDraft(input.id, input.reporterId, "submitted")).toBe(
      true,
    );
    expect(f.control.finishDraft(input.id, input.reporterId, "submitted")).toBe(
      false,
    );
    f.control.draft(draft("expired"), Date.now() - 1);
    expect(f.control.updateDraft(draft("expired"), Date.now() + 60_000)).toBe(
      false,
    );
    f.control.expireDrafts();
    expect(f.control.getDraft("expired", "reporter")).toBeNull();
  });

  test("report draft RAM cache is bounded, cloned and limited to fifteen minutes", () => {
    const f = fixture();
    const now = Date.now();
    const first = draft("first");
    f.control.draft(first, now + 24 * 60 * 60_000);
    first.message.content = "Changed after creation";
    expect(f.control.getDraft("first", "reporter")?.input.message.content).toBe(
      "Original",
    );
    expect(
      f.control.getDraft("first", "reporter")!.expiresAt,
    ).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    for (let index = 0; index < 500; index++)
      f.control.draft(draft(`item-${index}`), now + 15 * 60_000);
    expect(f.control.getDraft("first", "reporter")).toBeNull();
    expect(f.control.recentDraftCount("reporter", now - 1000)).toBe(500);
    f.control.expireDrafts(Date.now() + 15 * 60_000);
    expect(f.control.recentDraftCount("reporter", 0)).toBe(0);
  });
});

describe("message archive", () => {
  test("keeps revisions and deletion metadata in RAM without creating chat tables", () => {
    const f = fixture();
    let clock = 10_000;
    const archive = new Archive(f.store, { now: () => clock });
    const original = sample("message", "CHAT_SENTINEL");
    archive.saveSnapshot(original, config.guildId);
    archive.saveSnapshot(original, config.guildId);
    expect(archive.info(original.id)?.revision).toBe(0);
    archive.saveSnapshot({ ...original, content: "Edited" }, config.guildId);
    archive.saveSnapshot({ ...original, content: "Edited" }, config.guildId);
    expect(archive.info(original.id)?.revision).toBe(1);
    archive.saveSnapshot(original, config.guildId);
    expect(archive.info(original.id)?.revision).toBe(2);
    archive.deleted(original.id);
    clock++;
    archive.saveSnapshot(
      { ...original, content: "Cached after deletion" },
      config.guildId,
    );
    archive.deleted(original.id);
    expect(archive.info(original.id)?.deleted_at).toBe(10_000);
    expect(archive.recentGuild(config.guildId, userId)[0]?.content).toBe(
      "Cached after deletion",
    );
    expect(
      f.store.db
        .query(
          "SELECT 1 FROM sqlite_master WHERE name IN ('messages','message_versions')",
        )
        .get(),
    ).toBeNull();
    expect(new Archive(f.store).get(original.id)).toBeNull();
  });

  test("returns the author's newest guild messages across channels without crossing guilds", () => {
    const f = fixture();
    const archive = new Archive(f.store);
    archive.saveSnapshot(sample("old", "Old", 1000, "first"), config.guildId);
    archive.saveSnapshot(sample("new", "New", 3000, "second"), config.guildId);
    archive.saveSnapshot(
      sample("other-user", "Different user", 4000, "second", "other"),
      config.guildId,
    );
    archive.saveSnapshot(
      sample("other-guild", "Different guild", 5000, "second"),
      "other-guild",
    );
    expect(
      archive.recentGuild(config.guildId, userId).map((item) => item.id),
    ).toEqual(["new", "old"]);
    expect(
      archive.recentGuild(config.guildId, userId, 1).map((item) => item.id),
    ).toEqual(["new"]);
    expect(archive.recent("first", userId).map((item) => item.id)).toEqual([
      "old",
    ]);
  });

  test("enforces the cache capacity and one-hour lifetime on both writes and reads", () => {
    let clock = 1000;
    const archive = new Archive(undefined, { capacity: 2, now: () => clock });
    archive.saveSnapshot(sample("oldest"), config.guildId);
    archive.saveSnapshot(sample("second"), config.guildId);
    archive.saveSnapshot(sample("third"), config.guildId);
    expect(archive.get("oldest")).toBeNull();
    expect(archive.recentGuild(config.guildId, userId)).toHaveLength(2);
    clock += 3_600_000 - 1;
    expect(archive.get("second")).not.toBeNull();
    clock++;
    expect(archive.get("second")).toBeNull();
    expect(archive.info("third")).toBeNull();
    expect(archive.recentGuild(config.guildId, userId)).toHaveLength(0);
  });

  test("cache snapshots cannot be mutated through caller-owned objects", () => {
    const archive = new Archive();
    const original = {
      ...sample("message"),
      attachments: ["https://example.com/original"],
    };
    archive.saveSnapshot(original, config.guildId);
    original.content = "Mutated";
    original.attachments.push("https://example.com/new");
    const returned = archive.get(original.id)!;
    returned.content = "Also mutated";
    returned.attachments.length = 0;
    expect(archive.get(original.id)?.content).toBe("Original");
    expect(archive.get(original.id)?.attachments).toEqual([
      "https://example.com/original",
    ]);
  });

  test("invalid options cannot disable the hard cache limits", () => {
    let clock = 0;
    const archive = new Archive(undefined, {
      capacity: NaN,
      ttlMs: NaN,
      now: () => clock,
    });
    for (let index = 0; index < 1001; index++)
      archive.saveSnapshot(sample("entry-" + index), config.guildId);
    expect(archive.get("entry-0")).toBeNull();
    expect(archive.get("entry-1000")).not.toBeNull();
    clock += 3_600_000;
    expect(archive.get("entry-1000")).toBeNull();
  });
});
