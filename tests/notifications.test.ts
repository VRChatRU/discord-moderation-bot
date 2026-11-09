import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbedBuilder, type APIEmbed, type Client } from "discord.js";
import { Notifications } from "../src/notifications.ts";
import { Store } from "../src/store.ts";
import type { Action, ActionKind, Config, ReportInput } from "../src/types.ts";
import { notice } from "../src/ui.ts";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup(path = ":memory:") {
  const store = new Store(path);
  stores.push(store);
  const config: Config = {
    token: "unit-test",
    guildId: "100000000000000001",
    muteRoleId: "100000000000000002",
    modLogChannelId: "100000000000000003",
    textLogChannelId: "760706717188489226",
    botChannelId: "100000000000000004",
    inviteUrl: "https://discord.gg/example",
    moderatorRoleIds: [],
    kumaUrl: "https://example.org/push/test",
    rules: new Map(),
    previewThreadId: "1568864293712171018",
    scamAppealHours: 336,
    reportContext: "guild",
    killHistory: false,
  };
  const send = mock(async (_body: unknown) => ({ id: "100000000000000005" }));
  const post = mock(async (_route: string, _options: unknown) => ({
    id: "100000000000000006",
  }));
  const patch = mock(async (_route: string, _options: unknown) => ({}));
  const get = mock(
    async (_route: string, _options?: unknown): Promise<unknown> => ({
      embeds: [
        {
          color: 0xff0000,
          title: "Report",
          description: "Existing evidence",
          fields: [{ name: "Сообщение:", value: "Original message" }],
        },
      ],
    }),
  );
  const client = {
    isReady: mock(() => true),
    guilds: { cache: new Map([[config.guildId, { name: "VRChat RU" }]]) },
    users: { fetch: mock(async (id: string) => ({ id, send })) },
    rest: { post, patch, get },
  };
  const logger = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    close: async () => {},
  };
  return {
    store,
    config,
    send,
    post,
    patch,
    get,
    client,
    logger,
    notifications: new Notifications(
      client as unknown as Client,
      store,
      config,
      logger,
    ),
  };
}

function persistentSetup() {
  const directory = mkdtempSync(join(tmpdir(), "moderation-notifications-"));
  directories.push(directory);
  const path = join(directory, "bot.db");
  return { ...setup(path), path };
}

function reopen(fixture: ReturnType<typeof persistentSetup>) {
  stores.splice(stores.indexOf(fixture.store), 1);
  fixture.store.close();
  const store = new Store(fixture.path);
  stores.push(store);
  return {
    ...fixture,
    store,
    notifications: new Notifications(
      fixture.client as unknown as Client,
      store,
      fixture.config,
      fixture.logger,
    ),
  };
}

function makeAction(
  store: Store,
  reason: string | null = "Правило 1",
  kind: ActionKind = "ban",
): Action {
  return store.createAction({
    id: crypto.randomUUID(),
    interactionId: crypto.randomUUID(),
    guildId: "100000000000000001",
    actorId: "100000000000000010",
    targetId: "100000000000000011",
    channelId: "100000000000000012",
    kind,
    reason,
    durationDays: null,
    count: null,
    reportId: null,
    createdAt: Date.now(),
    confirmUntil: Date.now() + 120_000,
    messageIds: [],
  });
}

function makeReport(store: Store, overrides: Partial<ReportInput> = {}) {
  const input: ReportInput = {
    id: crypto.randomUUID(),
    interactionId: crypto.randomUUID(),
    guildId: "100000000000000001",
    channelId: "100000000000000012",
    messageId: "100000000000000020",
    targetId: "100000000000000011",
    reporterId: "100000000000000013",
    reason: null,
    message: {
      id: "100000000000000020",
      channelId: "100000000000000012",
      authorId: "100000000000000011",
      authorName: "User",
      content: "Original message",
      attachments: [],
      createdAt: Date.now(),
    },
    context: [],
    createdAt: Date.now(),
    ...overrides,
  };
  return store.createReport(input);
}

function auditCount(store: Store, event: string): number {
  return store.db
    .query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM audit WHERE event=?",
    )
    .get(event)!.count;
}

describe("notifications", () => {
  test("all current and legacy logs use only the reference color and description", async () => {
    const { notifications, store, post } = setup();
    const legacy = new EmbedBuilder()
      .setTitle("Old heading")
      .setDescription("Original content")
      .addFields({ name: "Reason", value: "Original reason" })
      .setFooter({ text: "Old footer" })
      .setTimestamp(0)
      .setAuthor({ name: "Old author" })
      .setImage("https://example.org/image.png");
    notifications.log(legacy, "current-log");
    store.enqueue("log", { embeds: [legacy.toJSON()] }, "legacy-log");
    const queued = store.dueOutbox().find((item) => item.id === "current-log")!;
    const embed = (queued.payload.embeds as APIEmbed[])[0]!;
    expect(Object.keys(embed).sort()).toEqual(["color", "description"]);
    await notifications.tick();
    for (const [, options] of post.mock.calls) {
      const rendered = (options as { body: { embeds: APIEmbed[] } }).body
        .embeds[0]!;
      expect(Object.keys(rendered).sort()).toEqual(["color", "description"]);
      expect(rendered.color).toBe(15844379);
      expect(rendered.description).toContain("Original content");
      expect(rendered.description).toContain("Original reason");
    }
  });

  test("direct action messages and legacy queued DMs share the reference frame", async () => {
    const { notifications, store, send } = setup();
    await notifications.actionDm(makeAction(store));
    store.enqueue(
      "dm",
      {
        targetId: "100000000000000011",
        embeds: [
          {
            title: "Old heading",
            description: "Original content",
            color: 0xff0000,
            fields: [{ name: "Reason", value: "Original reason" }],
            footer: { text: "Old footer" },
            timestamp: new Date(0).toISOString(),
          },
        ],
      },
      "legacy-dm",
    );
    await notifications.tick();
    expect(send).toHaveBeenCalledTimes(2);
    for (const [body] of send.mock.calls) {
      const embed = (body as { embeds: APIEmbed[] }).embeds[0]!;
      expect(embed.title).toBe("Внимание!");
      expect(embed.color).toBe(15844379);
      expect(embed.footer).toEqual({
        text: "Модерация VRChatRU",
        icon_url: "https://i.imgur.com/72pQbbd.png",
      });
      expect(embed.fields).toBeUndefined();
      expect(embed.timestamp).toBeUndefined();
    }
    const legacy = (send.mock.calls[1]![0] as { embeds: APIEmbed[] })
      .embeds[0]!;
    expect(legacy.description).toContain("Original content");
    expect(legacy.description).toContain("Original reason");
  });

  test("durable log and announcement delivery uses only configured channels and suppresses mentions", async () => {
    const { notifications, store, post, config } = setup();
    notifications.log(notice("Log", "<@100000000000000011> @everyone"), "log");
    notifications.announce(notice("Ready", "Connected"), "ready");
    store.enqueue(
      "log",
      {
        channelId: "999999999999999999",
        embeds: [{ description: "Must stay in mod-log" }],
      },
      "arbitrary",
    );
    expect(store.dueOutbox()).toHaveLength(3);
    await notifications.tick();
    expect(post.mock.calls.map((call) => call[0])).toEqual([
      `/channels/${config.modLogChannelId}/messages`,
      `/channels/${config.botChannelId}/messages`,
      `/channels/${config.modLogChannelId}/messages`,
    ]);
    for (const call of post.mock.calls) {
      expect(call[1]).toMatchObject({
        body: { allowed_mentions: { parse: [] }, enforce_nonce: true },
      });
      expect(
        (call[1] as { body: { nonce: string } }).body.nonce.length,
      ).toBeLessThanOrEqual(25);
    }
    expect(store.dueOutbox(Date.now() + 3_600_000)).toHaveLength(0);
    expect(auditCount(store, "notification_delivered")).toBe(0);
  });

  test("network failures preserve notifications with a bounded retry delay", async () => {
    const { notifications, store, post } = setup();
    notifications.log(notice("Log", "Saved"), "retry");
    store.db
      .query(
        "UPDATE outbox SET attempts=100,next_attempt_at=0 WHERE id='retry'",
      )
      .run();
    post.mockRejectedValue(new Error("Offline"));
    const before = Date.now();
    await notifications.tick();
    const row = store.db
      .query<{ attempts: number; due: number }, []>(
        "SELECT attempts,next_attempt_at AS due FROM outbox",
      )
      .get()!;
    expect(row.attempts).toBe(101);
    expect(row.due - before).toBeGreaterThanOrEqual(3_600_000);
    expect(row.due - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(store.dueOutbox()).toHaveLength(0);
  });

  test("text-log delivery is durable and restricted to its configured channel", async () => {
    const { notifications, store, post, config } = setup();
    const evidence = {
      name: "text-log-message.txt",
      content: "Full before\nFull after\nhttps://example.com/evidence.png",
    };
    notifications.textLog(
      notice("Changed", "Saved edit"),
      "text-event",
      evidence,
    );
    expect(store.dueOutbox()[0]!.payload.channelId).toBe(
      config.textLogChannelId,
    );
    post.mockRejectedValueOnce(new Error("offline"));
    await notifications.tick();
    expect(store.dueOutbox(Date.now() + 3_600_000)).toHaveLength(1);
    store.db.query("UPDATE outbox SET next_attempt_at=0").run();
    await notifications.tick();
    expect(post.mock.calls.map(([route]) => route)).toEqual([
      `/channels/${config.textLogChannelId}/messages`,
      `/channels/${config.textLogChannelId}/messages`,
    ]);
    expect(store.dueOutbox()).toHaveLength(0);
    const delivery = post.mock.calls[1]![1] as {
      files: { data: Buffer; name: string }[];
      body: { attachments: unknown[] };
    };
    expect(delivery.files[0]!.data.toString("utf8")).toBe(evidence.content);
    expect(delivery.body.attachments).toEqual([
      { id: "0", filename: evidence.name },
    ]);
  });

  test("DM is persisted before its first request and closed DMs warn moderators once", async () => {
    const { notifications, store, send, post } = setup();
    const action = makeAction(store);
    send.mockImplementation(async () => {
      expect(
        store.dueOutbox().some((item) => item.id === `dm:${action.id}`),
      ).toBe(true);
      throw { status: 403, code: 50007 };
    });
    expect(await notifications.actionDm(action)).toBe(false);
    expect(auditCount(store, "dm_failed")).toBe(1);
    expect(store.dueOutbox().map((item) => item.kind)).toEqual(["log"]);
    await notifications.tick();
    expect(post).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (post.mock.calls[0]![1] as { body: { embeds: APIEmbed[] } }).body
        .embeds[0],
    ).toEqual({
      color: 15844379,
      description: `⚠️ Не удалось отправить ЛС **<@${action.targetId}>**.`,
    });
  });

  test("queued DM retries keep their nonce and do not repeat moderator warnings", async () => {
    const { notifications, store, send } = setup();
    const action = makeAction(store);
    send.mockRejectedValue(new Error("Offline"));
    await notifications.actionDm(action);
    store.db.query("UPDATE outbox SET next_attempt_at=0").run();
    await notifications.tick();
    expect(auditCount(store, "dm_failed")).toBe(1);
    send.mockResolvedValue({ id: "100000000000000005" });
    store.db.query("UPDATE outbox SET next_attempt_at=0").run();
    await notifications.tick();
    const bodies = send.mock.calls.map(
      (call) =>
        call[0] as {
          nonce: string;
          enforceNonce: boolean;
          allowedMentions: { parse: string[] };
        },
    );
    expect(new Set(bodies.map((body) => body.nonce)).size).toBe(1);
    for (const body of bodies)
      expect(body).toMatchObject({
        allowedMentions: { parse: [] },
        enforceNonce: true,
      });
    expect(auditCount(store, "dm_sent")).toBe(1);
    expect(store.dueOutbox(Date.now() + 3_600_000)).toHaveLength(0);
  });

  test("failed actions do not receive a stale deferred restriction message", async () => {
    const { notifications, store, send } = setup();
    const action = makeAction(store);
    send.mockRejectedValue(new Error("Offline"));
    await notifications.actionDm(action);
    store.finishAction(action.id, "failed", "Ban rejected");
    store.db.query("UPDATE outbox SET next_attempt_at=0").run();
    await notifications.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(auditCount(store, "dm_skipped")).toBe(0);
    expect(store.dueOutbox()).toHaveLength(0);
  });

  test("reasonless moderation avoids DM except scam and unban", async () => {
    const { notifications, store, send } = setup();
    const action = makeAction(store, null);
    expect(await notifications.actionDm(action)).toBe(false);
    expect(
      await notifications.actionDm({
        ...action,
        kind: "purge",
        reason: "irrelevant",
      }),
    ).toBe(false);
    expect(send).toHaveBeenCalledTimes(0);
    expect(await notifications.actionDm({ ...action, kind: "scam" })).toBe(
      true,
    );
    expect(
      await notifications.actionDm({
        ...action,
        id: crypto.randomUUID(),
        kind: "unban",
      }),
    ).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("post-action DM queues atomically with action success and skips delivered receipts", async () => {
    const { notifications, store, send } = setup();
    const action = makeAction(store, null, "unban");
    expect(() =>
      store.db.transaction(() => {
        store.finishAction(action.id, "succeeded", "Unbanned");
        expect(notifications.queueActionDm(action)).toBe(true);
        throw new Error("Simulated crash before commit");
      })(),
    ).toThrow("Simulated crash");
    expect(store.getAction(action.id)!.state).toBe("pending");
    expect(store.dueOutbox()).toHaveLength(0);
    store.db.transaction(() => {
      store.finishAction(action.id, "succeeded", "Unbanned");
      expect(
        notifications.queueActionDm({ ...action, state: "succeeded" }),
      ).toBe(true);
    })();
    expect(store.getAction(action.id)!.state).toBe("succeeded");
    expect(store.dueOutbox().map((item) => item.kind)).toEqual(["dm"]);
    expect(send).toHaveBeenCalledTimes(0);
    // Worker can deliver after the caller stops, without replaying the moderation mutation.
    await notifications.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(notifications.queueActionDm(action)).toBe(false);
    expect(await notifications.actionDm(action)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.dueOutbox()).toHaveLength(0);
  });

  test("deleted report messages are durably replaced with their latest state", async () => {
    const { notifications, store, patch, post, config } = setup();
    config.moderatorRoleIds.push("100000000000000014");
    const report = makeReport(store);
    const oldId = "100000000000000030";
    store.setReportMessage(report.id, oldId);
    store.resolveReport(report.id, "100000000000000010", "Resolved");
    store.enqueue("report-edit", { reportId: report.id }, "edit");
    patch.mockRejectedValue({ status: 404, code: 10008 });
    await notifications.tick();
    expect(post).toHaveBeenCalledTimes(0);
    expect(store.dueOutbox().map((item) => item.kind)).toEqual(["report"]);
    await notifications.tick();
    expect(post).toHaveBeenCalledTimes(1);
    expect(store.getReport(report.id)!.modMessageId).toBe("100000000000000006");
    const rendered = (
      post.mock.calls[0]![1] as {
        body: { components: unknown[]; embeds: APIEmbed[] };
      }
    ).body;
    expect(rendered.components).toMatchObject([
      { components: [{ label: "Решено", disabled: true }] },
    ]);
    expect(
      (post.mock.calls[0]![1] as { body: { allowed_mentions: object } }).body
        .allowed_mentions,
    ).toEqual({ parse: [] });
    expect(rendered.embeds).toHaveLength(1);
    expect(rendered.embeds[0]!.color).toBe(0xff0000);
    expect(rendered.embeds[0]!.title).toBeTruthy();
    expect(rendered.embeds[0]!.url).toBe(
      `https://discord.com/channels/${report.guildId}/${report.channelId}/${report.messageId}`,
    );
    expect(
      (post.mock.calls[0]![1] as { files?: unknown }).files,
    ).toBeUndefined();
    expect(
      (post.mock.calls[0]![1] as { body: { attachments: unknown[] } }).body
        .attachments,
    ).toEqual([]);
    expect(store.dueOutbox()).toHaveLength(0);
    // Another queued edit of the old deleted message must not produce a second replacement.
    store.enqueue(
      "report",
      { reportId: report.id, replacingMessageId: oldId },
      "superseded-replacement",
    );
    await notifications.tick();
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("report retries and edits persist correctly without duplicating an existing report", async () => {
    const { notifications, store, patch, post, config } = setup();
    config.moderatorRoleIds.push("100000000000000014");
    const report = makeReport(store);
    store.enqueue("report", { reportId: report.id }, "report");
    post.mockRejectedValueOnce(new Error("Offline"));
    await notifications.tick();
    expect(store.getReport(report.id)!.modMessageId).toBeNull();
    store.db.query("UPDATE outbox SET next_attempt_at=0").run();
    await notifications.tick();
    expect(store.getReport(report.id)!.modMessageId).not.toBeNull();
    store.enqueue("report", { reportId: report.id }, "duplicate");
    store.enqueue("report-edit", { reportId: report.id }, "edit");
    await notifications.tick();
    expect(post).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledTimes(1);
    for (const [, options] of post.mock.calls) {
      expect(
        (options as { body: { allowed_mentions: object } }).body
          .allowed_mentions,
      ).toEqual({ parse: [], roles: ["100000000000000014"] });
    }
    expect(patch.mock.calls[0]![1]).toMatchObject({
      body: { allowed_mentions: { parse: [] } },
    });
    expect(patch.mock.calls[0]![1]).not.toHaveProperty("files");
    expect(
      (patch.mock.calls[0]![1] as { body: { attachments: unknown[] } }).body
        .attachments,
    ).toEqual([]);
  });

  test("report delivery preserves the red card, avatar and moderator-role reference", async () => {
    const { notifications, store, post, config } = setup();
    config.moderatorRoleIds.push("100000000000000014");
    const report = makeReport(store, {
      targetAvatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
    });
    store.enqueue("report", { reportId: report.id });
    await notifications.tick();
    const body = (
      post.mock.calls[0]![1] as {
        body: { embeds: APIEmbed[]; content: string; allowed_mentions: object };
      }
    ).body;
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0]!.color).toBe(0xff0000);
    expect(body.embeds[0]!.thumbnail?.url).toBe(report.targetAvatarUrl);
    expect(body.embeds[0]!.fields?.length).toBeGreaterThan(3);
    expect(body.content).toBe("**<@&100000000000000014>**");
    expect(body.allowed_mentions).toEqual({
      parse: [],
      roles: ["100000000000000014"],
    });
  });

  test("reports deliver evidence without persisting message bodies or uploading transcript attachments", async () => {
    const { notifications, store, post, config } = setup();
    const original = {
      id: "100000000000000020",
      channelId: "100000000000000012",
      authorId: "100000000000000011",
      authorName: "User",
      content: `${"Я".repeat(4000)}ORIGINAL_END`,
      attachments: ["https://cdn.discordapp.com/evidence.png"],
      createdAt: Date.now(),
    };
    const report = makeReport(store, {
      message: original,
      context: Array.from({ length: 10 }, (_, index) => ({
        ...original,
        id: String(700000000000000000n + BigInt(index)),
        content: `${"x".repeat(4000)}MESSAGE_${index}_END`,
      })),
    });
    store.enqueue(
      "report",
      { reportId: report.id, channelId: config.botChannelId },
      "evidence",
    );
    await notifications.tick();
    expect(post.mock.calls[0]![0]).toBe(
      `/channels/${config.modLogChannelId}/messages`,
    );
    const options = post.mock.calls[0]![1] as {
      body: { attachments: unknown[] };
      files?: unknown;
    };
    expect(options.files).toBeUndefined();
    expect(options.body.attachments).toEqual([]);
    const row = store.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM reports WHERE id=?",
      )
      .get(report.id)!;
    expect(row.payload).not.toContain("ORIGINAL_END");
    expect(row.payload).not.toContain("MESSAGE_0_END");
    expect(row.payload).not.toContain("evidence.png");
    expect(store.hasReportEvidence(report.id)).toBe(false);
    notifications.log(notice("Other log", "No report evidence"), "other");
    await notifications.tick();
    expect(
      (post.mock.calls[1]![1] as { files?: unknown }).files,
    ).toBeUndefined();
  });

  test("moderation DM and log jobs reconstruct from case references after a restart", async () => {
    const initial = persistentSetup();
    const action = makeAction(
      initial.store,
      "Правило 3. Проверка восстановления",
    );
    initial.store.finishAction(action.id, "succeeded", "Banned");
    initial.store.setSanction({
      guildId: action.guildId,
      targetId: action.targetId!,
      actionId: action.id,
      kind: "ban",
      roleId: null,
      expiresAt: null,
    });
    const completed = initial.store.getAction(action.id)!;
    initial.notifications.actionLog(completed, "case-log");
    initial.notifications.queueActionDm(completed);
    for (const row of initial.store.db
      .query<{ payload: string }, []>("SELECT payload FROM outbox")
      .all()) {
      expect(row.payload).not.toContain("embeds");
      expect(row.payload).not.toContain(action.reason!);
    }
    const fixture = reopen(initial);
    await fixture.notifications.tick();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fixture.send.mock.calls[0])).toContain(
      action.reason!,
    );
    expect(JSON.stringify(fixture.post.mock.calls[0])).toContain(
      action.reason!,
    );
    expect(fixture.store.dueOutbox()).toHaveLength(0);
  });

  test("delayed restriction notices cannot follow their expiry unban or supersede a newer sanction", async () => {
    for (const kind of ["ban", "mute"] as const) {
      const fixture = setup();
      const action = makeAction(fixture.store, "Правило 1", kind);
      fixture.store.finishAction(action.id, "succeeded", "Completed");
      fixture.notifications.queueActionDm(fixture.store.getAction(action.id)!);
      if (kind === "ban")
        fixture.store.enqueue(
          "dm",
          { template: "unban", targetId: action.targetId, actionId: action.id },
          "expiry",
        );
      await fixture.notifications.tick();
      const sent = kind === "ban" ? 1 : 0;
      expect(fixture.send).toHaveBeenCalledTimes(sent);
      if (kind === "ban")
        expect(JSON.stringify(fixture.send.mock.calls[0])).toContain(
          "Бан снят.",
        );
      const newer = makeAction(fixture.store, "Правило 2", kind);
      fixture.store.setSanction({
        guildId: action.guildId,
        targetId: action.targetId!,
        kind,
        actionId: newer.id,
        roleId: null,
        expiresAt: null,
      });
      fixture.store.enqueue(
        "dm",
        { actionId: action.id, targetId: action.targetId },
        "stale-restriction",
      );
      await fixture.notifications.tick();
      expect(fixture.send).toHaveBeenCalledTimes(sent);
      expect(fixture.store.dueOutbox()).toHaveLength(0);
    }
  });

  test("a delayed unban invitation cannot follow a newer tracked ban", async () => {
    const fixture = setup();
    const action = makeAction(fixture.store, null, "unban");
    fixture.store.finishAction(action.id, "succeeded", "Unbanned");
    fixture.notifications.queueActionDm(fixture.store.getAction(action.id)!);
    const newer = makeAction(fixture.store);
    fixture.store.setSanction({
      guildId: action.guildId,
      targetId: action.targetId!,
      kind: "ban",
      actionId: newer.id,
      roleId: null,
      expiresAt: null,
    });
    await fixture.notifications.tick();
    expect(fixture.send).toHaveBeenCalledTimes(0);
    expect(fixture.store.dueOutbox()).toHaveLength(0);
  });

  test("a report update after restart preserves evidence from its Discord card", async () => {
    const initial = persistentSetup();
    const report = makeReport(initial.store);
    initial.store.setReportMessage(report.id, "100000000000000030");
    initial.store.resolveReport(
      report.id,
      "100000000000000010",
      "Жалоба закрыта",
    );
    initial.store.enqueue(
      "report-edit",
      { reportId: report.id },
      "report-edit",
    );
    const fixture = reopen(initial);
    fixture.get.mockResolvedValueOnce({
      embeds: [
        {
          color: 0xff0000,
          description: "Existing evidence",
          fields: [
            { name: "Сообщение:", value: "Original message" },
            { name: "Решение:", value: "Old resolution" },
            { name: "Статус:", value: "Old status" },
          ],
        },
      ],
    });
    await fixture.notifications.tick();
    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.post).toHaveBeenCalledTimes(0);
    const body = (
      fixture.patch.mock.calls[0]![1] as {
        body: {
          embeds: APIEmbed[];
          components: unknown[];
          attachments: unknown[];
        };
      }
    ).body;
    expect(body.embeds[0]!.description).toBe("Existing evidence");
    expect(body.embeds[0]!.fields).toContainEqual({
      name: "Сообщение:",
      value: "Original message",
    });
    expect(
      body.embeds[0]!.fields!.some((field) =>
        ["Решение:", "Статус:"].includes(field.name),
      ),
    ).toBe(false);
    expect(body.components).toMatchObject([
      { components: [{ label: "Решено", disabled: true }] },
    ]);
    expect(body.attachments).toEqual([]);
    expect(fixture.store.dueOutbox()).toHaveLength(0);
  });

  test("an unsent report recovers live Discord evidence after restarting and retries indexing", async () => {
    const initial = persistentSetup();
    const report = makeReport(initial.store);
    initial.store.enqueue("report", { reportId: report.id }, "report");
    const fixture = reopen(initial);
    const raw = {
      id: report.messageId,
      channel_id: report.channelId,
      author: { id: report.targetId, username: "User42" },
      content: "Fetched original",
      attachments: [],
      timestamp: new Date(report.createdAt - 1000).toISOString(),
    };
    const context = {
      ...raw,
      id: "100000000000000021",
      channel_id: "100000000000000019",
      content: "Fetched context",
    };
    fixture.get
      .mockResolvedValueOnce(raw)
      .mockResolvedValueOnce({ retry_after: 0.1 });
    await fixture.notifications.tick();
    expect(fixture.post).toHaveBeenCalledTimes(0);
    expect(fixture.store.dueOutbox(Date.now() + 3_600_000)).toHaveLength(1);
    fixture.store.db.query("UPDATE outbox SET next_attempt_at=0").run();
    fixture.get.mockResolvedValueOnce(raw).mockResolvedValueOnce({
      messages: [
        [
          context,
          context,
          {
            ...context,
            author: { id: report.reporterId, username: "Other" },
            content: "Wrong user",
          },
        ],
      ],
    });
    await fixture.notifications.tick();
    expect(fixture.post).toHaveBeenCalledTimes(1);
    const body = (
      fixture.post.mock.calls[0]![1] as {
        body: { embeds: APIEmbed[]; attachments: unknown[] };
      }
    ).body;
    expect(JSON.stringify(body.embeds)).toContain("Fetched original");
    expect(JSON.stringify(body.embeds)).toContain("Fetched context");
    expect(JSON.stringify(body.embeds)).not.toContain("Wrong user");
    const history = body.embeds[0]!.fields!.filter(
      (field) => field.name === "Последние сообщения пользователя:",
    )
      .map((field) => field.value)
      .join("\n");
    expect(history.match(/Fetched context/g)).toHaveLength(1);
    expect(history).not.toContain("<#");
    expect(body.attachments).toEqual([]);
    expect(
      fixture.store.db
        .query<{ payload: string }, []>("SELECT payload FROM reports")
        .get()!.payload,
    ).not.toContain("Fetched");
    expect(fixture.store.hasReportEvidence(report.id)).toBe(false);
    const searchQuery = (
      fixture.get.mock.calls[3]![1] as { query: URLSearchParams }
    ).query;
    expect(searchQuery.get("author_id")).toBe(report.targetId);
    expect(searchQuery.has("max_id")).toBe(true);
    expect(fixture.store.dueOutbox()).toHaveLength(0);
  });

  test("text-log jobs keep event metadata after restart without storing message text", async () => {
    const initial = persistentSetup();
    initial.notifications.textLog(
      notice("Changed", "PRIVATE_BODY"),
      "text-event",
      { name: "text-log-event.txt", content: "PRIVATE_FILE" },
      {
        template: "text-log",
        outcome: "edited",
        targetId: "100000000000000011",
        sourceChannelId: "100000000000000012",
        messageId: "100000000000000020",
      },
    );
    const fixture = reopen(initial);
    await fixture.notifications.tick();
    const options = fixture.post.mock.calls[0]![1] as {
      body: { embeds: APIEmbed[] };
      files?: unknown;
    };
    expect(fixture.post.mock.calls[0]![0]).toBe(
      `/channels/${fixture.config.textLogChannelId}/messages`,
    );
    expect(options.files).toBeUndefined();
    expect(options.body.embeds[0]!.description).toContain(
      "Текст недоступен после перезапуска.",
    );
    expect(options.body.embeds[0]!.description).toContain("100000000000000020");
    expect(JSON.stringify(options)).not.toContain("PRIVATE_");
    expect(fixture.store.dueOutbox()).toHaveLength(0);
  });

  test("invalid transient payloads are discarded instead of retried forever", async () => {
    const { notifications, store, post } = setup();
    expect(() =>
      notifications.log({ toJSON: () => ({ description: "x".repeat(4097) }) }),
    ).toThrow("Discord limits");
    store.enqueue(
      "log",
      {
        embeds: [
          { description: "x".repeat(3500) },
          { description: "x".repeat(3500) },
        ],
      },
      "invalid",
    );
    notifications.log(notice("Valid", "Still delivered"), "valid");
    await notifications.tick();
    expect(auditCount(store, "notification_invalid")).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(store.dueOutbox(Date.now() + 3_600_000)).toHaveLength(0);
  });

  test("offline and overlapping ticks do not consume or duplicate notifications", async () => {
    const { notifications, store, post, client } = setup();
    notifications.log(notice("Log", "Saved"), "log");
    client.isReady.mockReturnValue(false);
    await notifications.tick();
    expect(post).toHaveBeenCalledTimes(0);
    expect(store.dueOutbox()).toHaveLength(1);
    client.isReady.mockReturnValue(true);
    let finish!: (value: { id: string }) => void;
    post.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = notifications.tick();
    await notifications.tick();
    expect(post).toHaveBeenCalledTimes(1);
    finish({ id: "100000000000000006" });
    await running;
    expect(store.dueOutbox()).toHaveLength(0);
  });
});
