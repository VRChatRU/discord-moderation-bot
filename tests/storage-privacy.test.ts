import { describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Notifications } from "../src/notifications.ts";
import { loadConfig } from "../src/config.ts";
import type { APIEmbed, Client } from "discord.js";
import type { ActionInput, ReportInput } from "../src/types.ts";

const sentinel = "CHAT_EVIDENCE_MUST_NOT_REMAIN_947351";
const messageId = "123456789012345678";

function report(id = "report-1"): ReportInput {
  const message = {
    id: messageId,
    channelId: "channel",
    authorId: "target",
    authorName: sentinel,
    content: sentinel,
    attachments: [`https://example.com/${sentinel}.png`],
    createdAt: 1000,
  };
  return {
    id,
    interactionId: `interaction-${id}`,
    guildId: "guild",
    channelId: "channel",
    messageId,
    targetId: "target",
    reporterId: "reporter",
    reason: "KEEP_REPORT_REASON",
    message,
    context: [message],
    contextWarning: sentinel,
    reporterName: sentinel,
    targetAvatarUrl: `https://example.com/${sentinel}.png`,
    createdAt: 1000,
  };
}

function action(): ActionInput {
  return {
    id: "case-1",
    interactionId: "case-interaction",
    guildId: "guild",
    actorId: "moderator",
    targetId: "target",
    channelId: "channel",
    kind: "ban",
    reason: "KEEP_MOD_REASON",
    durationDays: 1,
    count: null,
    reportId: null,
    createdAt: 1000,
    confirmUntil: 5000,
    messageIds: [],
  };
}

function temporaryDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "discord-storage-privacy-"));
  const path = join(dir, "app.db");
  return {
    path,
    remove() {
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(dir);
    },
  };
}

describe("storage minimization", () => {
  test("report evidence is temporary RAM while its status and moderation reason survive reopening", () => {
    const file = temporaryDatabase();
    let store = new Store(file.path);
    try {
      store.createReport(report());
      store.claimReport("report-1");
      store.setReportMessage("report-1", "moderator-message");
      expect(store.hasReportEvidence("report-1")).toBe(true);
      expect(store.getReport("report-1")?.message.content).toBe(sentinel);
      expect(
        store.db
          .query<{ payload: string }, []>("SELECT payload FROM reports")
          .get()?.payload,
      ).not.toContain(sentinel);
      store.close();
      store = new Store(file.path);
      const restored = store.getReport("report-1")!;
      expect(store.hasReportEvidence("report-1")).toBe(false);
      expect(restored.state).toBe("processing");
      expect(restored.modMessageId).toBe("moderator-message");
      expect(restored.reason).toBe("KEEP_REPORT_REASON");
      expect(restored.message.content).toBe("Текст не сохранён.");
      expect(restored.message.attachments).toEqual([]);
      expect(restored.message.createdAt).toBe(
        Number((BigInt(messageId) >> 22n) + 1_420_070_400_000n),
      );
      expect(restored.context).toEqual([]);
      expect(restored.contextWarning).toContain("не сохраняется");
    } finally {
      store.close();
      file.remove();
    }
  });

  test("report cache has a maximum of 100 entries, expires and can be cleared without changing report state", () => {
    const store = new Store(":memory:");
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      for (let index = 0; index <= 100; index++)
        store.createReport(report(`report-${index}`));
      expect(store.hasReportEvidence("report-0")).toBe(false);
      expect(store.hasReportEvidence("report-1")).toBe(true);
      store.clearReportEvidence("report-1");
      expect(store.getReport("report-1")?.message.content).toBe(
        "Текст не сохранён.",
      );
      expect(store.getReport("report-1")?.state).toBe("open");
      clock.mockReturnValue(1000 + 15 * 60_000);
      expect(store.hasReportEvidence("report-100")).toBe(false);
    } finally {
      clock.mockRestore();
      store.close();
    }
  });

  test("rolled-back report evidence is never exposed as a persisted report", () => {
    const store = new Store(":memory:");
    try {
      expect(() =>
        store.db.transaction(() => {
          store.createReport(report());
          throw new Error("Rollback");
        })(),
      ).toThrow("Rollback");
      expect(store.getReport("report-1")).toBeNull();
      expect(store.hasReportEvidence("report-1")).toBe(false);
    } finally {
      store.close();
    }
  });

  test("queued bodies remain only in RAM and reopening resumes reference-only jobs", () => {
    const file = temporaryDatabase();
    let store = new Store(file.path);
    try {
      store.enqueue(
        "dm",
        {
          actionId: "case-1",
          targetId: "target",
          template: "action-dm",
          count: 1,
          embeds: [{ description: sentinel }],
          evidence: { name: "chat.txt", content: sentinel },
          files: [sentinel],
          content: sentinel,
          context: [sentinel],
        },
        "delivery",
      );
      expect(
        JSON.stringify(store.dueOutbox(Date.now() + 1)[0]?.payload),
      ).toContain(sentinel);
      expect(
        store.db
          .query<{ payload: string }, []>("SELECT payload FROM outbox")
          .get()?.payload,
      ).not.toContain(sentinel);
      store.retryOutbox("delivery", sentinel, 1000);
      expect(
        store.db
          .query<{ last_error: string }, []>("SELECT last_error FROM outbox")
          .get()?.last_error,
      ).toBe("error");
      store.close();
      store = new Store(file.path);
      expect(store.dueOutbox(Number.MAX_SAFE_INTEGER)[0]?.payload).toEqual({
        actionId: "case-1",
        targetId: "target",
        template: "action-dm",
        count: 1,
      });
      store.completeOutbox("delivery");
      expect(store.dueOutbox(Number.MAX_SAFE_INTEGER)).toEqual([]);
    } finally {
      store.close();
      file.remove();
    }
  });

  test("volatile outbox cache expires and is bounded by both count and byte size", () => {
    const store = new Store(":memory:");
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      for (let index = 0; index <= 500; index++)
        store.enqueue(
          "log",
          { template: "notice", content: `${sentinel}-${index}` },
          `job-${index}`,
        );
      const first = store.dueOutbox(1000, 2);
      expect(first[0]?.payload).toEqual({ template: "notice" });
      expect(first[1]?.payload.content).toBe(`${sentinel}-1`);
      clock.mockReturnValue(1000 + 3_600_000);
      expect(
        store
          .dueOutbox(Number.MAX_SAFE_INTEGER, 2)
          .every((item) => item.payload.content === undefined),
      ).toBe(true);
      for (let index = 0; index <= 500; index++)
        store.completeOutbox(`job-${index}`);
      const large = "x".repeat(9 * 1024 * 1024);
      store.enqueue("log", { template: "notice", content: large }, "large-1");
      store.enqueue("log", { template: "notice", content: large }, "large-2");
      const jobs = store.dueOutbox(Number.MAX_SAFE_INTEGER, 2);
      expect(jobs[0]?.payload).toEqual({ template: "notice" });
      expect((jobs[1]?.payload.content as string).length).toBe(large.length);
      expect(
        store.db
          .query<{ bytes: number }, []>(
            "SELECT SUM(length(payload)) AS bytes FROM outbox",
          )
          .get()!.bytes,
      ).toBeLessThan(100);
    } finally {
      clock.mockRestore();
      store.close();
    }
  });

  test("only sanitized runtime proofs are kept in audit", () => {
    const store = new Store(":memory:");
    try {
      store.audit("message_received", { content: sentinel });
      store.audit("moderation.attempt", {
        actionId: "case-1",
        roleId: "role-1",
        targetId: "target",
        content: sentinel,
        message: { content: sentinel },
      });
      store.audit("moderation.applied", {
        actionId: "case-1",
        result: sentinel,
      });
      store.audit("dm_sent", {
        actionId: "case-1",
        notificationId: "delivery",
        retry: true,
        text: sentinel,
      });
      store.audit("dm_failed", {
        targetId: "target",
        notificationId: "delivery-2",
        code: 50007,
        status: 403,
        body: sentinel,
      });
      const rows = store.db
        .query<{ event: string; data: string }, []>(
          "SELECT event,data FROM audit ORDER BY id",
        )
        .all();
      expect(rows).toHaveLength(4);
      expect(JSON.stringify(rows)).not.toContain(sentinel);
      expect(JSON.parse(rows[0]!.data)).toEqual({
        actionId: "case-1",
        roleId: "role-1",
        targetId: "target",
      });
      expect(JSON.parse(rows[2]!.data).retry).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("legacy privacy migration", () => {
  test("backfills legacy moderation templates before discarding message bodies and delivers the correct recovered notices", async () => {
    const file = temporaryDatabase();
    let store = new Store(file.path);
    try {
      store.createAction(action());
      store.finishAction("case-1", "succeeded", "Banned");
      store.createAction({
        ...action(),
        id: "unban-1",
        interactionId: "unban-interaction",
        kind: "unban",
        durationDays: null,
      });
      store.finishAction("unban-1", "succeeded", "Unbanned");
      store.audit("dm_failed", {
        actionId: "case-1",
        targetId: "target",
        notificationId: "dm:case-1",
      });
      const legacy = [
        [
          "appeal-invite:unban-1",
          "dm",
          { targetId: "target", embeds: [{ description: sentinel }] },
        ],
        [
          "expiry-dm:case-1",
          "dm",
          {
            targetId: "target",
            actionId: "case-1",
            embeds: [{ description: sentinel }],
          },
        ],
        [
          "dm:case-1",
          "dm",
          { targetId: "target", embeds: [{ description: sentinel }] },
        ],
        ["action-log:case-1", "log", { embeds: [{ description: sentinel }] }],
        ["appeal-log:unban-1", "log", { embeds: [{ description: sentinel }] }],
        [
          "dm-warning:dm:case-1",
          "log",
          { embeds: [{ description: sentinel }] },
        ],
        [
          "legacy-correction",
          "dm",
          {
            targetId: "target",
            actionId: "case-1",
            embeds: [
              {
                description:
                  "Предыдущее уведомление отменено: действие не выполнено.",
              },
            ],
          },
        ],
        [
          "expiry-dm:explicit",
          "dm",
          {
            targetId: "target",
            template: "action-cancelled",
            embeds: [{ description: sentinel }],
          },
        ],
        ["legacy-unknown", "log", { embeds: [{ description: sentinel }] }],
      ] as const;
      for (const [id, kind, payload] of legacy)
        store.db
          .query(
            "INSERT INTO outbox(id,kind,payload,next_attempt_at) VALUES(?,?,?,0)",
          )
          .run(id, kind, JSON.stringify(payload));
      store.db.exec("PRAGMA user_version=1");
      store.close();
      store = new Store(file.path);
      const jobs = new Map(
        store
          .dueOutbox(Number.MAX_SAFE_INTEGER, 100)
          .map((item) => [item.id, item.payload]),
      );
      expect(jobs.get("appeal-invite:unban-1")).toEqual({
        targetId: "target",
        template: "unban",
        actionId: "unban-1",
      });
      expect(jobs.get("expiry-dm:case-1")?.template).toBe("unban");
      expect(jobs.get("dm:case-1")).toMatchObject({
        actionId: "case-1",
        template: "action-dm",
      });
      expect(jobs.get("action-log:case-1")).toEqual({
        template: "action-log",
        actionId: "case-1",
        actionState: "succeeded",
      });
      expect(jobs.get("appeal-log:unban-1")).toMatchObject({
        template: "action-log",
        actionId: "unban-1",
      });
      expect(jobs.get("dm-warning:dm:case-1")).toMatchObject({
        template: "dm-failed",
        targetId: "target",
        actionId: "case-1",
      });
      expect(jobs.get("legacy-correction")?.template).toBe("action-cancelled");
      expect(jobs.get("expiry-dm:explicit")?.template).toBe("action-cancelled");
      expect(jobs.get("legacy-unknown")).toEqual({});
      expect(JSON.stringify([...jobs.values()])).not.toContain(sentinel);
      const sent: Array<{ embeds: APIEmbed[] }> = [];
      const posted: Array<{ body: { embeds: APIEmbed[] } }> = [];
      const client = {
        isReady: () => true,
        users: {
          fetch: async (id: string) => ({
            id,
            send: mock(async (body: { embeds: APIEmbed[] }) => {
              sent.push(body);
            }),
          }),
        },
        rest: {
          post: mock(
            async (
              _route: string,
              options: { body: { embeds: APIEmbed[] } },
            ) => {
              posted.push(options);
              return { id: "sent-message" };
            },
          ),
        },
      } as unknown as Client;
      const config = loadConfig({
        DISCORD_TOKEN: "test",
        GUILD_ID: "666306330230915093",
        MUTE_ROLE_ID: "987396975743860766",
        KUMA_PUSH_URL: "https://example.com/push",
        SERVER_INVITE_URL: "https://vrcru.org/discord",
      });
      const notifications = new Notifications(client, store, config, {
        info() {},
        warn() {},
        error() {},
        async close() {},
      });
      await notifications.tick();
      await notifications.tick();
      expect(sent).toHaveLength(4);
      expect(sent[0]!.embeds[0]!.description).toContain("Бан снят.");
      expect(sent[1]!.embeds[0]!.description).toContain("Бан снят.");
      expect(sent[1]!.embeds[0]!.description).toContain(config.inviteUrl);
      expect(
        sent.some((body) =>
          body.embeds[0]!.description!.includes("Вы были забанены"),
        ),
      ).toBe(false);
      expect(sent[2]!.embeds[0]!.description).toContain(
        "действие не выполнено",
      );
      expect(posted).toHaveLength(3);
      expect(
        posted.some((entry) =>
          entry.body.embeds[0]!.description!.includes(
            "Не удалось отправить ЛС",
          ),
        ),
      ).toBe(true);
      expect(store.dueOutbox(Number.MAX_SAFE_INTEGER)).toEqual([]);
    } finally {
      store.close();
      file.remove();
    }
  });

  test("removes legacy chat data from tables, free pages and WAL while preserving cases, receipts and active jobs", () => {
    const file = temporaryDatabase();
    let store = new Store(file.path);
    try {
      store.createAction(action());
      store.claimAction("case-1", "moderator", 2000);
      store.setActionResult("case-1", "KEEP_MOD_RESULT");
      store.setSanction({
        guildId: "guild",
        targetId: "target",
        kind: "ban",
        actionId: "case-1",
        expiresAt: 9000,
        roleId: null,
      });
      store.db.exec(`
        CREATE TABLE messages(id TEXT PRIMARY KEY,snapshot TEXT);
        CREATE TABLE message_versions(id INTEGER PRIMARY KEY,message_id TEXT,snapshot TEXT);
        CREATE TABLE report_drafts(id TEXT PRIMARY KEY,payload TEXT);
        CREATE TABLE text_log_events(id TEXT PRIMARY KEY,kind TEXT,message_id TEXT,created_at INTEGER,payload TEXT);
        CREATE TABLE text_log_pending_edits(message_id TEXT PRIMARY KEY,channel_id TEXT,before_snapshot TEXT,attempts INTEGER,next_attempt_at INTEGER,version TEXT);
        CREATE TABLE reconcile_queue(action_id TEXT PRIMARY KEY,next_at INTEGER,attempts INTEGER);
      `);
      store.db.query("INSERT INTO messages VALUES('message',?)").run(sentinel);
      store.db
        .query("INSERT INTO message_versions VALUES(1,'message',?)")
        .run(sentinel);
      store.db
        .query("INSERT INTO report_drafts VALUES('draft',?)")
        .run(sentinel);
      store.db
        .query(
          "INSERT INTO text_log_events VALUES('edit-1','edited','message',1000,?)",
        )
        .run(sentinel);
      store.db
        .query(
          "INSERT INTO text_log_pending_edits VALUES('message','channel',?,3,4000,'revision')",
        )
        .run(sentinel);
      store.db
        .query("INSERT INTO reconcile_queue VALUES('case-1',5000,2)")
        .run();
      store.db
        .query(
          "INSERT INTO reports(id,interaction_id,state,payload,mod_message_id) VALUES('report-1','interaction-report-1','processing',?,'moderator-message')",
        )
        .run(JSON.stringify(report()));
      store.db
        .query(
          "INSERT INTO outbox(id,kind,payload,next_attempt_at,last_error) VALUES('delivery','dm',?,0,?)",
        )
        .run(
          JSON.stringify({
            actionId: "case-1",
            template: "action-dm",
            embeds: [{ description: sentinel }],
            evidence: { content: sentinel },
          }),
          sentinel,
        );
      store.db
        .query(
          "INSERT INTO audit(created_at,event,data) VALUES(1000,'message_received',?)",
        )
        .run(JSON.stringify({ content: sentinel }));
      store.db
        .query(
          "INSERT INTO audit(created_at,event,data) VALUES(2000,'moderation.attempt',?)",
        )
        .run(
          JSON.stringify({
            actionId: "case-1",
            roleId: "role-1",
            text: sentinel,
          }),
        );
      store.db
        .query(
          "INSERT INTO audit(created_at,event,data) VALUES(3000,'dm_sent',?)",
        )
        .run(
          JSON.stringify({
            actionId: "case-1",
            notificationId: "delivery",
            text: sentinel,
          }),
        );
      store.db.exec("PRAGMA user_version=1; PRAGMA wal_checkpoint(TRUNCATE)");
      expect(readFileSync(file.path).includes(Buffer.from(sentinel))).toBe(
        true,
      );
      store.close();
      store = new Store(file.path);
      const names = store.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table'",
        )
        .all()
        .map((row) => row.name);
      expect(names).not.toContain("messages");
      expect(names).not.toContain("message_versions");
      expect(names).not.toContain("report_drafts");
      expect(
        store.db
          .query<{ name: string }, []>("PRAGMA table_info(text_log_events)")
          .all()
          .map((row) => row.name),
      ).not.toContain("payload");
      expect(
        store.db
          .query<{ name: string }, []>(
            "PRAGMA table_info(text_log_pending_edits)",
          )
          .all()
          .map((row) => row.name),
      ).not.toContain("before_snapshot");
      expect(
        store.db
          .query<{ attempts: number; version: string }, []>(
            "SELECT * FROM text_log_pending_edits",
          )
          .get(),
      ).toMatchObject({ attempts: 3, version: "revision" });
      expect(
        store.db.query("SELECT * FROM reconcile_queue").get(),
      ).not.toBeNull();
      expect(store.getAction("case-1")?.reason).toBe("KEEP_MOD_REASON");
      expect(store.getAction("case-1")?.result).toBe("KEEP_MOD_RESULT");
      expect(store.getAction("case-1")?.state).toBe("running");
      expect(store.getSanction("guild", "target", "ban")?.expiresAt).toBe(9000);
      expect(store.getReport("report-1")?.state).toBe("processing");
      expect(store.getReport("report-1")?.message.content).toBe(
        "Текст не сохранён.",
      );
      expect(store.dueOutbox(Number.MAX_SAFE_INTEGER)[0]?.payload).toEqual({
        actionId: "case-1",
        template: "action-dm",
      });
      const audits = store.db
        .query<{ event: string; data: string }, []>(
          "SELECT event,data FROM audit",
        )
        .all();
      expect(audits.map((row) => row.event)).toEqual([
        "moderation.attempt",
        "dm_sent",
      ]);
      expect(JSON.stringify(audits)).not.toContain(sentinel);
      expect(
        store.db
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()?.user_version,
      ).toBe(2);
      store.close();
      store = new Store(file.path);
      expect(readFileSync(file.path).includes(Buffer.from(sentinel))).toBe(
        false,
      );
      if (existsSync(`${file.path}-wal`))
        expect(
          readFileSync(`${file.path}-wal`).includes(Buffer.from(sentinel)),
        ).toBe(false);
    } finally {
      store.close();
      file.remove();
    }
  });

  test("refuses migration while a live runtime lease exists and leaves legacy evidence untouched", () => {
    const file = temporaryDatabase();
    const store = new Store(file.path);
    try {
      store.db.exec(
        "CREATE TABLE messages(content TEXT); CREATE TABLE runtime_lease(id INTEGER PRIMARY KEY,owner TEXT,expires_at INTEGER)",
      );
      store.db.query("INSERT INTO messages VALUES(?)").run(sentinel);
      store.db
        .query("INSERT INTO runtime_lease VALUES(1,'running-process',?)")
        .run(Date.now() + 60_000);
      store.db.exec("PRAGMA user_version=1");
      expect(() => new Store(file.path)).toThrow("active runtime lease");
      expect(
        store.db
          .query<{ content: string }, []>("SELECT content FROM messages")
          .get()?.content,
      ).toBe(sentinel);
      expect(
        store.db
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()?.user_version,
      ).toBe(1);
    } finally {
      store.close();
      file.remove();
    }
  });

  test("handles a partial legacy schema without requiring unrelated bot tables", () => {
    const file = temporaryDatabase();
    const legacy = new Database(file.path);
    legacy.exec("CREATE TABLE messages(content TEXT); PRAGMA user_version=1");
    legacy.query("INSERT INTO messages VALUES(?)").run(sentinel);
    legacy.close();
    const store = new Store(file.path);
    try {
      expect(
        store.db
          .query("SELECT 1 FROM sqlite_master WHERE name='messages'")
          .get(),
      ).toBeNull();
      expect(store.listSanctions()).toEqual([]);
      expect(readFileSync(file.path).includes(Buffer.from(sentinel))).toBe(
        false,
      );
    } finally {
      store.close();
      file.remove();
    }
  });
});
