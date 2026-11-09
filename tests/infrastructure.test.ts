import { describe, expect, spyOn, test, vi } from "bun:test";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveReason } from "../src/config.ts";
import { startKuma } from "../src/kuma.ts";
import { createLogger } from "../src/logger.ts";
import { Store } from "../src/store.ts";
import type { ActionInput, ReportInput } from "../src/types.ts";

function action(id = "case-1"): ActionInput {
  return {
    id,
    interactionId: `interaction-${id}`,
    guildId: "guild",
    actorId: "actor",
    targetId: "target",
    channelId: "channel",
    kind: "ban",
    reason: "A reason",
    durationDays: 1,
    count: null,
    reportId: null,
    createdAt: 1000,
    confirmUntil: 5000,
    messageIds: [],
  };
}

function report(id = "report-1"): ReportInput {
  return {
    id,
    interactionId: `interaction-${id}`,
    guildId: "guild",
    channelId: "channel",
    messageId: "message",
    targetId: "target",
    reporterId: "reporter",
    reason: null,
    createdAt: 1000,
    context: [],
    message: {
      id: "message",
      channelId: "channel",
      authorId: "target",
      authorName: "Name",
      content: "Text",
      attachments: [],
      createdAt: 1000,
    },
  };
}

const env = {
  DISCORD_TOKEN: "fake-test-token",
  GUILD_ID: "123456789012345678",
  MUTE_ROLE_ID: "123456789012345679",
  MOD_LOG_CHANNEL_ID: "123456789012345680",
  KUMA_PUSH_URL: "https://kuma.invalid/api/push/test",
  SERVER_INVITE_URL: "https://discord.gg/test",
};

describe("configuration", () => {
  test("uses agreed server defaults and validates the return invitation", () => {
    const config = loadConfig({ ...env, MOD_LOG_CHANNEL_ID: "" });
    expect(config.modLogChannelId).toBe("801483885132513280");
    expect(config.textLogChannelId).toBe("760706717188489226");
    expect(config.botChannelId).toBe("764477131345362956");
    expect(config.inviteUrl).toBe("https://discord.gg/test");
    expect(config.reportContext).toBe("guild");
    expect(config.scamAppealHours).toBe(14 * 24);
    expect(config.killHistory).toBe(false);
    expect(
      loadConfig({
        ...env,
        SERVER_INVITE_URL: "https://discord.com/invite/test",
      }).inviteUrl,
    ).toBe("https://discord.com/invite/test");
    expect(
      loadConfig({ ...env, SERVER_INVITE_URL: "https://vrcru.org/discord" })
        .inviteUrl,
    ).toBe("https://vrcru.org/discord");
    for (const invalid of [
      "http://discord.gg/test",
      "javascript:alert(1)",
      "https://user:password@discord.gg/test",
      "https://discord.gg/test#fragment",
      "not a URL",
    ]) {
      expect(() => loadConfig({ ...env, SERVER_INVITE_URL: invalid })).toThrow(
        "SERVER_INVITE_URL",
      );
    }
  });

  test("parses IDs, rule references and explicit settings without modifying free text", () => {
    const config = loadConfig({
      ...env,
      MODERATOR_ROLE_IDS:
        "123456789012345681, 123456789012345682 123456789012345681",
      RULE_1: " Be kind ",
      REPORT_CONTEXT: "channel",
      SCAM_APPEAL_HOURS: "24",
      KILL_FULL_HISTORY: "false",
    });
    expect(config.moderatorRoleIds).toEqual([
      "123456789012345681",
      "123456789012345682",
    ]);
    expect(config.rules.get(1)).toBe("Be kind");
    expect(config.reportContext).toBe("channel");
    expect(config.scamAppealHours).toBe(24);
    expect(config.killHistory).toBe(false);
    expect(resolveReason(" RULE_1 ", config.rules)).toBe("Правило 1. Be kind");
    expect(resolveReason("1", config.rules)).toBe("Правило 1. Be kind");
    expect(resolveReason("A separate reason", config.rules)).toBe(
      "A separate reason",
    );
    expect(resolveReason(" ", config.rules)).toBeNull();
    expect(() => resolveReason("2", config.rules)).toThrow("не настроено");
    expect(() => resolveReason("12", config.rules)).toThrow("не настроено");
  });

  test("rejects missing credentials, malformed IDs, nonfinite delays, and unsafe URL schemes", () => {
    expect(() => loadConfig({ ...env, DISCORD_TOKEN: "" })).toThrow(
      "DISCORD_TOKEN",
    );
    expect(() => loadConfig({ ...env, GUILD_ID: "123" })).toThrow("GUILD_ID");
    expect(() =>
      loadConfig({ ...env, GUILD_ID: "99999999999999999999" }),
    ).toThrow("GUILD_ID");
    expect(() => loadConfig({ ...env, SCAM_APPEAL_HOURS: "Infinity" })).toThrow(
      "SCAM_APPEAL_HOURS",
    );
    expect(() => loadConfig({ ...env, SCAM_APPEAL_HOURS: "-1" })).toThrow(
      "SCAM_APPEAL_HOURS",
    );
    expect(() =>
      loadConfig({ ...env, KUMA_PUSH_URL: "file:///secret" }),
    ).toThrow("KUMA_PUSH_URL");
    expect(() => loadConfig({ ...env, REPORT_CONTEXT: "users" })).toThrow(
      "REPORT_CONTEXT",
    );
    expect(() => loadConfig({ ...env, KILL_FULL_HISTORY: "no" })).toThrow(
      "KILL_FULL_HISTORY",
    );
  });
});

describe("durable store", () => {
  test("confirmation claims are atomic, actor-bound, time-bound and idempotent", () => {
    const store = new Store(":memory:");
    try {
      store.createAction(action());
      expect(
        store.createAction({
          ...action("other-id"),
          interactionId: "interaction-case-1",
        }).id,
      ).toBe("case-1");
      expect(store.claimAction("case-1", "other-actor", 2000)).toBe(false);
      expect(store.claimAction("case-1", "actor", 2000)).toBe(true);
      expect(store.claimAction("case-1", "actor", 2000)).toBe(false);
      store.setActionResult("case-1", "Deleted 5");
      expect(store.getAction("case-1")?.state).toBe("running");
      expect(store.getAction("case-1")?.completedAt).toBeNull();
      store.finishAction("case-1", "succeeded", "done");
      store.finishAction("case-1", "failed", "late error");
      expect(store.getAction("case-1")?.state).toBe("succeeded");
      expect(store.getAction("case-1")?.result).toBe("done");
      store.createAction(action("expired"));
      expect(store.claimAction("expired", "actor", 5000)).toBe(false);
      expect(store.expireActions(5000)).toBe(1);
      expect(store.getAction("expired")?.state).toBe("expired");
    } finally {
      store.close();
    }
  });

  test("reopening preserves interrupted work and sanctions without replaying it", () => {
    const dir = mkdtempSync(join(tmpdir(), "discord-moderation-store-"));
    const file = join(dir, "store.db");
    let store = new Store(file);
    try {
      store.createAction(action());
      store.claimAction("case-1", "actor", 2000);
      store.setSanction({
        guildId: "guild",
        targetId: "target",
        kind: "ban",
        actionId: "case-1",
        expiresAt: 9000,
        roleId: null,
      });
      store.close();
      store = new Store(file);
      expect(store.listInterruptedActions().map((item) => item.id)).toEqual([
        "case-1",
      ]);
      expect(store.getSanction("guild", "target", "ban")?.expiresAt).toBe(9000);
      store.removeSanction("guild", "target", "ban", "stale-case");
      expect(store.listSanctions()).toHaveLength(1);
      store.removeSanction("guild", "target", "ban", "case-1");
      expect(store.listSanctions()).toHaveLength(0);
    } finally {
      store.close();
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(`${file}${suffix}`, { force: true });
      rmdirSync(dir);
    }
  });

  test("report claims prevent simultaneous resolutions and survive retries", () => {
    const store = new Store(":memory:");
    try {
      store.createReport(report());
      expect(
        store.createReport({
          ...report("other"),
          interactionId: "interaction-report-1",
        }).id,
      ).toBe("report-1");
      expect(store.claimReport("report-1")).toBe(true);
      expect(store.claimReport("report-1")).toBe(false);
      expect(store.listOpenReports()[0]?.state).toBe("processing");
      store.releaseReport("report-1");
      expect(store.claimReport("report-1")).toBe(true);
      store.setReportMessage("report-1", "mod-message");
      store.resolveReport("report-1", "moderator", "scam");
      store.resolveReport("report-1", "another-moderator", "changed");
      expect(store.getReport("report-1")?.resolvedBy).toBe("moderator");
      expect(store.getReport("report-1")?.modMessageId).toBe("mod-message");
      expect(store.claimReport("report-1")).toBe(false);
      expect(store.listOpenReports()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("outbox keeps bodies in RAM, persists references, deduplicates and backs off", () => {
    const store = new Store(":memory:");
    try {
      store.enqueue("log", { value: "first", actionId: "case-1" }, "delivery");
      store.enqueue(
        "log",
        { value: "duplicate", actionId: "case-1" },
        "delivery",
      );
      const item = store.dueOutbox(Date.now() + 1)[0]!;
      expect(item.payload).toEqual({ value: "first", actionId: "case-1" });
      expect(
        store.db
          .query<{ payload: string }, []>("SELECT payload FROM outbox")
          .get()?.payload,
      ).toBe('{"actionId":"case-1"}');
      store.retryOutbox("delivery", "offline", 10_000);
      expect(store.dueOutbox(14_999)).toHaveLength(0);
      expect(store.dueOutbox(15_000)[0]?.attempts).toBe(1);
      store.retryOutbox("delivery", "offline", 20_000);
      expect(store.dueOutbox(29_999)).toHaveLength(0);
      expect(store.dueOutbox(30_000)[0]?.attempts).toBe(2);
      store.completeOutbox("delivery");
      expect(store.dueOutbox(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
      store.audit("action.started", { content: "not retained" });
      store.audit("moderation.attempt", {
        actionId: "case-1",
        content: "not retained",
      });
      expect(
        store.db.query<{ event: string }, []>("SELECT event FROM audit").get()
          ?.event,
      ).toBe("moderation.attempt");
    } finally {
      store.close();
    }
  });
});

test("logger appends across restarts and redacts secrets, nested fields and errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "discord-moderation-log-"));
  const path = join(dir, "app.log");
  const consoleLog = spyOn(console, "log").mockImplementation(() => {});
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  const token = 'token-with-"quote';
  try {
    const logger = createLogger(path, [token]);
    logger.info("Started", {
      token,
      nested: { password: "password" },
      extra: `value ${token}`,
    });
    await logger.close();
    const reopened = createLogger(path, [token]);
    reopened.error("Failed", {
      error: new Error(`Request ${token} failed`),
      count: 3n,
    });
    await reopened.close();
    const lines = (await Bun.file(path).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].data.token).toBe("[REDACTED]");
    expect(lines[0].data.nested.password).toBe("[REDACTED]");
    expect(lines[0].data.extra).toBe("value [REDACTED]");
    expect(lines[1].data.error.message).toBe("Request [REDACTED] failed");
    expect(lines[1].data.count).toBe("3");
  } finally {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    rmSync(path, { force: true });
    rmdirSync(dir);
  }
});

test("Kuma starts after 60 seconds, remains silent offline, recovers and stops", async () => {
  vi.useFakeTimers();
  const shutdown = new AbortController();
  const requests: string[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (resource: Parameters<typeof fetch>[0]) => {
        requests.push(String(resource));
        if (requests.length === 1) throw new Error("Offline");
        return new Response(null);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const errorMock = spyOn(console, "error").mockImplementation(() => {});
  let ready = true;
  try {
    startKuma("https://kuma.invalid/push", () => ready, shutdown.signal);
    vi.advanceTimersByTime(59_999);
    expect(requests).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(requests).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    ready = false;
    vi.advanceTimersByTime(60_000);
    expect(requests).toHaveLength(1);
    ready = true;
    vi.advanceTimersByTime(60_000);
    expect(requests).toHaveLength(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(errorMock).not.toHaveBeenCalled();
    shutdown.abort();
    vi.advanceTimersByTime(60_000);
    expect(requests).toHaveLength(2);
  } finally {
    shutdown.abort();
    fetchMock.mockRestore();
    errorMock.mockRestore();
    vi.useRealTimers();
  }
});
