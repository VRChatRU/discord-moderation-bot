import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  PermissionFlagsBits,
  PermissionsBitField,
  Collection,
  type Client,
} from "discord.js";
import {
  Moderation,
  actionStartedAt,
  auditReason,
  caseMarker,
  errorMessage,
  fetchMember,
  isPermanentError,
  sanctionFor,
  UserFacingError,
  validSnowflake,
} from "../src/moderation.ts";
import { PurgePartialError } from "../plugins/purge.ts";
import { Store } from "../src/store.ts";
import type { Action, ActionKind, Config, Logger } from "../src/types.ts";

const ids = {
  guild: "123456789012345670",
  owner: "123456789012345671",
  actor: "123456789012345672",
  bot: "123456789012345673",
  target: "123456789012345674",
  role: "123456789012345675",
  channel: "123456789012345676",
};
const config: Config = {
  token: "test",
  guildId: ids.guild,
  muteRoleId: ids.role,
  modLogChannelId: ids.channel,
  textLogChannelId: "760706717188489226",
  moderatorRoleIds: [],
  kumaUrl: "https://example.com/push/test",
  rules: new Map(),
  botChannelId: ids.channel,
  inviteUrl: "https://discord.gg/example",
  previewThreadId: ids.channel,
  scamAppealHours: 0,
  reportContext: "author",
  killHistory: true,
};
const logger: Logger = { info() {}, warn() {}, error() {}, async close() {} };
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function role(id: string, position: number) {
  return {
    id,
    position,
    managed: false,
    permissions: new PermissionsBitField(),
    comparePositionTo(other: { position: number }) {
      return position - other.position;
    },
  };
}

function member(id: string, position: number, bits: bigint[]) {
  const cache = new Set<string>();
  const permissions = new PermissionsBitField(bits);
  return {
    id,
    user: { id, bot: id === ids.bot },
    permissions,
    permissionsIn() {
      return permissions;
    },
    roles: {
      cache,
      highest: role(`${id}-role`, position),
      add: mock(async (roleId: string) => {
        cache.add(roleId);
      }),
      remove: mock(async (roleId: string) => {
        cache.delete(roleId);
      }),
    },
    kick: mock(async () => {}),
  };
}

function fixture(options: Partial<Config> = {}) {
  const store = new Store(":memory:");
  stores.push(store);
  const cfg = { ...config, ...options };
  const actor = member(ids.actor, 50, [PermissionFlagsBits.Administrator]);
  const target = member(ids.target, 10, []);
  const bot = member(ids.bot, 90, [PermissionFlagsBits.Administrator]);
  const members = new Map([
    [actor.id, actor],
    [target.id, target],
    [bot.id, bot],
  ]);
  const bans = new Map<string, { reason: string | null }>();
  const channel = {
    id: ids.channel,
    isTextBased: () => true,
    messages: { delete: mock(async (_id: string) => {}) },
    bulkDelete: mock(async (_messages: string[]) => {}),
  };
  const guild = {
    id: ids.guild,
    ownerId: ids.owner,
    roles: {
      fetch: mock(async (_id?: string, _options?: { force?: boolean }) =>
        role(ids.role, 20),
      ),
    },
    channels: {
      fetch: mock(
        async (_id?: string, _options?: { force?: boolean }) => channel,
      ),
    },
    members: {
      fetchMe: mock(async () => bot),
      fetch: mock(async ({ user }: { user: string }) => {
        const result = members.get(user);
        if (!result) throw { code: 10007, status: 404 };
        return result;
      }),
      ban: mock(
        async (
          userId: string,
          options: { reason: string; deleteMessageSeconds: number },
        ) => {
          bans.set(userId, { reason: options.reason });
        },
      ),
      unban: mock(async (userId: string) => {
        bans.delete(userId);
      }),
    },
    bans: {
      fetch: mock(async ({ user }: { user: string }) => {
        const ban = bans.get(user);
        if (!ban) throw { code: 10026, status: 404 };
        return ban;
      }),
    },
    fetchAuditLogs: mock(async () => ({ entries: new Map() })),
  };
  const fetchUser = mock(async (id: string) => ({ id }));
  const fetchGuild = mock(async (_options?: unknown) => guild);
  const client = {
    guilds: { fetch: fetchGuild },
    users: { fetch: fetchUser },
  } as unknown as Client;
  const engine = new Moderation(client, store, cfg, logger);
  const action = (kind: ActionKind, changes: Partial<Action> = {}) => {
    const id = crypto.randomUUID();
    const created = store.createAction({
      id,
      interactionId: crypto.randomUUID(),
      guildId: ids.guild,
      actorId: ids.actor,
      targetId: kind === "purge" ? null : ids.target,
      channelId: ids.channel,
      kind,
      reason: null,
      durationDays: null,
      count: null,
      reportId: null,
      createdAt: Date.now(),
      confirmUntil: Date.now() + 60_000,
      messageIds: [],
      ...changes,
    });
    store.claimAction(created.id, created.actorId);
    return store.getAction(created.id)!;
  };
  return {
    store,
    cfg,
    actor,
    target,
    bot,
    members,
    bans,
    channel,
    guild,
    engine,
    action,
    fetchUser,
    fetchGuild,
  };
}

describe("moderation authorization", () => {
  test("a stale owner cache cannot preserve privileges after ownership transfer", async () => {
    const f = fixture();
    f.guild.ownerId = ids.actor;
    Object.defineProperty(f.actor, "permissions", {
      get: () =>
        new PermissionsBitField(
          f.guild.ownerId === ids.actor
            ? [PermissionFlagsBits.Administrator]
            : [],
        ),
    });
    f.fetchGuild.mockImplementation(async (options) => {
      if (
        options &&
        typeof options === "object" &&
        "force" in options &&
        options.force
      )
        f.guild.ownerId = ids.owner;
      return f.guild;
    });
    await expect(f.engine.execute(f.action("ban"))).rejects.toThrow("нет прав");
    expect(f.guild.members.ban).not.toHaveBeenCalled();
  });

  test("role permissions and hierarchy are refreshed before applying moderation", async () => {
    for (const change of ["permission", "position"] as const) {
      const f = fixture();
      f.guild.roles.fetch.mockImplementation(async (id) => {
        if (!id) {
          if (change === "permission")
            f.actor.permissions.remove(PermissionFlagsBits.Administrator);
          else f.target.roles.highest = role("promoted-target", 75);
        }
        return role(ids.role, 20);
      });
      await expect(f.engine.execute(f.action("ban"))).rejects.toBeInstanceOf(
        UserFacingError,
      );
      expect(f.guild.members.ban).not.toHaveBeenCalled();
    }
  });

  test("purge cannot use cached channel overwrites after deletion permission is revoked", async () => {
    const f = fixture();
    const freshChannel = { ...f.channel, permissionOverwriteRevoked: true };
    f.guild.channels.fetch.mockImplementation(async (_id, options) =>
      options?.force ? freshChannel : f.channel,
    );
    f.actor.permissionsIn = (channel?: {
      permissionOverwriteRevoked?: boolean;
    }) =>
      new PermissionsBitField(
        channel?.permissionOverwriteRevoked
          ? [PermissionFlagsBits.ViewChannel]
          : [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ManageMessages,
            ],
      );
    const action = f.action("purge", {
      count: 1,
      messageIds: ["123456789012345678"],
    });
    await expect(f.engine.execute(action)).rejects.toThrow("нет права удалять");
    expect(f.channel.messages.delete).not.toHaveBeenCalled();
    expect(f.channel.bulkDelete).not.toHaveBeenCalled();
  });

  test("rejects malformed and overflowing snowflakes before calling Discord", async () => {
    const f = fixture();
    for (const targetId of [
      "bad-id",
      "123",
      "000000000000000000",
      "99999999999999999999",
    ]) {
      expect(validSnowflake(targetId)).toBe(false);
      await expect(
        f.engine.validate(f.action("ban", { targetId })),
      ).rejects.toThrow("корректный ID");
    }
    expect(f.fetchGuild).not.toHaveBeenCalled();
    expect(validSnowflake(ids.target)).toBe(true);
    expect(validSnowflake("18446744073709551615")).toBe(true);
  });

  test("requires an atomically claimed action before executing mutations", async () => {
    const f = fixture();
    const action = f.action("ban");
    f.store.finishAction(action.id, "cancelled", "Cancelled");
    await expect(f.engine.execute(action)).rejects.toThrow("не подтверждено");
    expect(f.guild.members.ban).not.toHaveBeenCalled();
    expect(f.fetchGuild).not.toHaveBeenCalled();
  });
  test("checks permissions again after confirmation", async () => {
    const f = fixture();
    const action = f.action("ban");
    await f.engine.validate(action);
    f.actor.permissions.remove(PermissionFlagsBits.Administrator);
    await expect(f.engine.execute(action)).rejects.toBeInstanceOf(
      UserFacingError,
    );
    expect(f.guild.members.ban).not.toHaveBeenCalled();
  });

  test("configured moderator role permits actions but cannot bypass hierarchy", async () => {
    const f = fixture({ moderatorRoleIds: ["moderator"] });
    f.actor.permissions.remove(PermissionFlagsBits.Administrator);
    f.actor.roles.cache.add("moderator");
    await f.engine.validate(f.action("ban"));
    f.target.roles.highest = role("higher-role", 60);
    await expect(f.engine.execute(f.action("ban"))).rejects.toThrow(
      "ниже вашей роли",
    );
  });

  test("protects self, owner, bot and bot hierarchy", async () => {
    const f = fixture();
    for (const targetId of [ids.actor, ids.owner, ids.bot]) {
      await expect(
        f.engine.validate(f.action("ban", { targetId })),
      ).rejects.toBeInstanceOf(UserFacingError);
    }
    f.actor.roles.highest = role("actor-role", 100);
    f.target.roles.highest = role("target-role", 95);
    await expect(f.engine.validate(f.action("ban"))).rejects.toThrow(
      "ниже роли бота",
    );
  });

  test("does not treat a network error as an absent guild member", async () => {
    const f = fixture();
    f.guild.members.fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(fetchMember(f.guild as never, ids.target)).rejects.toThrow(
      "offline",
    );
  });

  test("mute protects existing and ineffective administrator mutes", async () => {
    const f = fixture();
    f.target.permissions.add(PermissionFlagsBits.Administrator);
    await expect(f.engine.validate(f.action("mute"))).rejects.toThrow(
      "администратора",
    );
    f.target.permissions.remove(PermissionFlagsBits.Administrator);
    f.target.roles.cache.add(ids.role);
    await expect(f.engine.validate(f.action("mute"))).rejects.toThrow(
      "уже есть роль",
    );
  });

  test("mute never grants a misconfigured administrator role", async () => {
    const f = fixture();
    const dangerousRole = role(ids.role, 20);
    dangerousRole.permissions.add(PermissionFlagsBits.Administrator);
    f.guild.roles.fetch.mockResolvedValue(dangerousRole);
    await expect(f.engine.execute(f.action("mute"))).rejects.toThrow(
      "не должна выдавать право «Администратор»",
    );
    expect(f.target.roles.add).not.toHaveBeenCalled();
    expect(f.store.getSanction(ids.guild, ids.target, "mute")).toBeNull();
  });

  test("rejects non-finite and unsupported durations", async () => {
    const f = fixture();
    for (const durationDays of [NaN, Infinity, -1, 0, 36501]) {
      await expect(
        f.engine.validate({ ...f.action("ban"), durationDays }),
      ).rejects.toBeInstanceOf(UserFacingError);
    }
    await expect(
      f.engine.validate(f.action("scam", { durationDays: 1 })),
    ).rejects.toBeInstanceOf(UserFacingError);
  });
});

describe("moderation mutations and deadlines", () => {
  test("a claimed non-idempotent action without a mutation attempt is known not to have run", async () => {
    for (const kind of ["kick", "warn", "purge"] as const) {
      const f = fixture();
      const action = f.action(kind);
      f.fetchGuild.mockRejectedValue(new Error("offline"));
      expect(await f.engine.reconcile(action)).toBe("failed");
      expect(f.fetchGuild).not.toHaveBeenCalled();
    }
  });

  test("an interrupted kick or purge remains uncertain once its mutation attempt began", async () => {
    for (const kind of ["kick", "purge"] as const) {
      const f = fixture();
      const action = f.action(kind);
      f.store.audit("moderation.attempt", { actionId: action.id });
      expect(await f.engine.reconcile(action)).toBe("uncertain");
      expect(f.target.kick).not.toHaveBeenCalled();
      expect(f.channel.messages.delete).not.toHaveBeenCalled();
    }
  });

  test("completed kick, warning and purge recover from their durable success receipt", async () => {
    for (const kind of ["kick", "warn", "purge"] as const) {
      const f = fixture();
      const action = f.action(
        kind,
        kind === "purge"
          ? { count: 1, messageIds: ["123456789012345678"] }
          : {},
      );
      await f.engine.execute(action);
      f.fetchGuild.mockRejectedValue(new Error("offline during recovery"));
      expect(await f.engine.reconcile(action)).toBe("succeeded");
      expect(f.guild.members.ban).not.toHaveBeenCalled();
    }
  });

  test("recovery never recreates a completed ban after a moderator has removed it", async () => {
    const f = fixture();
    const action = f.action("ban", { durationDays: 1 });
    await f.engine.execute(action);
    f.store.removeSanction(ids.guild, ids.target, "ban", action.id);
    f.bans.delete(ids.target);
    expect(await f.engine.reconcile(action)).toBe("succeeded");
    expect(f.store.getSanction(ids.guild, ids.target, "ban")).toBeNull();
    expect(f.guild.members.ban).toHaveBeenCalledTimes(1);
  });

  test("a confirmed mute remains successful if its member leaves before the final receipt", async () => {
    const f = fixture();
    const action = f.action("mute", { durationDays: 1 });
    await f.engine.execute(action);
    f.store.db
      .query(
        "DELETE FROM audit WHERE event='moderation.applied' AND json_extract(data,'$.actionId')=?",
      )
      .run(action.id);
    f.members.delete(ids.target);
    expect(await f.engine.reconcile(action)).toBe("succeeded");
    expect(f.store.getSanction(ids.guild, ids.target, "mute")?.actionId).toBe(
      action.id,
    );
  });

  test("mute recovery uses its original role even if configuration changed during the restart", async () => {
    const f = fixture();
    const action = f.action("mute", { durationDays: 1 });
    const originalRole = f.cfg.muteRoleId;
    f.store.audit("moderation.attempt", {
      actionId: action.id,
      roleId: originalRole,
    });
    f.cfg.muteRoleId = "123456789012345699";
    f.target.roles.cache.add(originalRole);
    f.guild.fetchAuditLogs.mockResolvedValueOnce({
      entries: new Collection([
        [
          "entry",
          {
            targetId: ids.target,
            reason: auditReason(action),
            changes: [{ key: "$add", new: [{ id: originalRole }] }],
          },
        ],
      ]),
    });
    expect(await f.engine.reconcile(action)).toBe("succeeded");
    expect(f.store.getSanction(ids.guild, ids.target, "mute")?.roleId).toBe(
      originalRole,
    );
  });

  test("ban, kill and scam use exact Discord deletion windows", async () => {
    for (const [kind, seconds] of [
      ["ban", 0],
      ["kill", 604800],
      ["scam", 86400],
    ] as const) {
      const f = fixture();
      const action = f.action(kind);
      await f.engine.execute(action);
      expect(f.guild.members.ban.mock.calls[0]![1]).toEqual({
        reason: auditReason(action),
        deleteMessageSeconds: seconds,
      });
      expect(f.store.getSanction(ids.guild, ids.target, "ban")?.actionId).toBe(
        action.id,
      );
    }
  });

  test("an existing ban is never overwritten", async () => {
    const f = fixture();
    f.bans.set(ids.target, { reason: "manual ban" });
    await expect(f.engine.execute(f.action("ban"))).rejects.toThrow(
      "уже заблокирован",
    );
    expect(f.guild.members.ban).not.toHaveBeenCalled();
  });

  test("ban by ID works for a user outside the guild", async () => {
    const f = fixture();
    f.members.delete(ids.target);
    await f.engine.execute(f.action("ban"));
    expect(f.guild.members.ban).toHaveBeenCalledTimes(1);
    expect(f.fetchUser).toHaveBeenCalledWith(ids.target);
  });

  test("does not warn or ban a nonexistent account outside the guild", async () => {
    const f = fixture();
    f.members.delete(ids.target);
    f.fetchUser.mockRejectedValue({ code: 10013, status: 404 });
    for (const kind of ["warn", "ban"] as const) {
      await expect(f.engine.execute(f.action(kind))).rejects.toEqual({
        code: 10013,
        status: 404,
      });
    }
    expect(f.guild.members.ban).not.toHaveBeenCalled();
    expect(
      f.store.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM audit WHERE event='moderation.attempt'",
        )
        .get()?.count,
    ).toBe(0);
  });

  test("temporary mute persists a deadline measured from execution", async () => {
    const f = fixture();
    const action = f.action("mute", { durationDays: 0.5 });
    const before = Date.now();
    await f.engine.execute(action);
    const sanction = f.store.getSanction(ids.guild, ids.target, "mute")!;
    expect(sanction.roleId).toBe(ids.role);
    expect(sanction.expiresAt).toBeGreaterThanOrEqual(before + 43_200_000);
    expect(sanction.expiresAt).toBeLessThanOrEqual(Date.now() + 43_200_000);
  });

  test("expiration does not undo a replacement manual ban", async () => {
    const f = fixture();
    const action = f.action("ban", { durationDays: 1 });
    await f.engine.execute(action);
    f.store.setSanction({
      ...f.store.getSanction(ids.guild, ids.target, "ban")!,
      expiresAt: Date.now() - 1,
    });
    f.bans.set(ids.target, { reason: "new manual ban" });
    await expect(
      f.engine.expire(f.store.getSanction(ids.guild, ids.target, "ban")!),
    ).resolves.toContain("изменена");
    expect(f.guild.members.unban).not.toHaveBeenCalled();
    expect(f.store.getSanction(ids.guild, ids.target, "ban")).toBeNull();
  });

  test("expiration is idempotent and CAS protects a newer sanction", async () => {
    const f = fixture();
    const oldAction = f.action("ban", { durationDays: 1 });
    const newerAction = f.action("ban", { durationDays: 2 });
    const stale = sanctionFor(oldAction, f.cfg, Date.now() - 3 * 86_400_000);
    const current = sanctionFor(
      newerAction,
      f.cfg,
      Date.now() - 3 * 86_400_000,
    );
    f.store.setSanction(current);
    f.bans.set(ids.target, { reason: auditReason(newerAction) });
    await f.engine.expire(stale);
    expect(f.guild.members.unban).not.toHaveBeenCalled();
    await f.engine.expire(current);
    await f.engine.expire(current);
    expect(f.guild.members.unban).toHaveBeenCalledTimes(1);
  });

  test("never expires a permanent sanction or a sanction before its current deadline", async () => {
    const f = fixture();
    const action = f.action("ban", { durationDays: 1 });
    await f.engine.execute(action);
    const sanction = f.store.getSanction(ids.guild, ids.target, "ban")!;
    expect(await f.engine.expire(sanction)).toContain("ещё не истёк");
    f.store.setSanction({ ...sanction, expiresAt: null });
    expect(await f.engine.expire(sanction)).toContain("ещё не истёк");
    expect(f.guild.members.unban).not.toHaveBeenCalled();
    expect(f.store.getSanction(ids.guild, ids.target, "ban")?.actionId).toBe(
      action.id,
    );
  });

  test("recovery proves ban ownership and preserves the original deadline", async () => {
    const f = fixture();
    const action = f.action("ban", {
      durationDays: 1,
      createdAt: Date.now() - 3600_000,
    });
    f.bans.set(ids.target, { reason: auditReason(action) });
    expect(await f.engine.reconcile(action)).toBe("succeeded");
    expect(f.store.getSanction(ids.guild, ids.target, "ban")?.expiresAt).toBe(
      action.createdAt + 86_400_000,
    );
    f.bans.set(ids.target, { reason: "manual ban" });
    expect(await f.engine.reconcile(action)).toBe("uncertain");
  });

  test("mute recovery without ownership evidence is uncertain", async () => {
    const f = fixture();
    f.target.roles.cache.add(ids.role);
    f.bot.permissions.remove(PermissionFlagsBits.Administrator);
    expect(await f.engine.reconcile(f.action("mute"))).toBe("uncertain");
  });

  test("uses the persisted mutation start for deadline recovery and appeal eligibility", async () => {
    const f = fixture();
    const action = f.action("scam", {
      createdAt: Date.now() - 15 * 86_400_000,
    });
    const executedAt = action.createdAt + 120_000;
    f.store.audit("moderation.attempt", { actionId: action.id });
    f.store.db
      .query("UPDATE audit SET created_at=? WHERE event='moderation.attempt'")
      .run(executedAt);
    f.store.audit("moderation.attempt", { actionId: action.id });
    f.store.finishAction(action.id, "succeeded", "Recovered now");
    expect(actionStartedAt(f.store, f.store.getAction(action.id)!)).toBe(
      executedAt,
    );
    const temporary = f.action("ban", {
      durationDays: 1,
      createdAt: Date.now() - 3600_000,
    });
    const temporaryStartedAt = temporary.createdAt + 100_000;
    f.store.audit("moderation.attempt", { actionId: temporary.id });
    f.store.db
      .query(
        "UPDATE audit SET created_at=? WHERE json_extract(data,'$.actionId')=?",
      )
      .run(temporaryStartedAt, temporary.id);
    f.bans.set(ids.target, { reason: auditReason(temporary) });
    expect(await f.engine.reconcile(temporary)).toBe("succeeded");
    expect(f.store.getSanction(ids.guild, ids.target, "ban")?.expiresAt).toBe(
      temporaryStartedAt + 86_400_000,
    );
  });

  test("reconciliation never overwrites another tracked ban or mute", async () => {
    for (const kind of ["ban", "mute"] as const) {
      const f = fixture();
      const old = f.action(kind, { durationDays: 1 });
      const current = f.action(kind, { durationDays: 2 });
      f.store.setSanction(sanctionFor(current, f.cfg));
      if (kind === "ban") f.bans.set(ids.target, { reason: auditReason(old) });
      else f.target.roles.cache.add(ids.role);
      expect(await f.engine.reconcile(old)).toBe("uncertain");
      expect(f.store.getSanction(ids.guild, ids.target, kind)?.actionId).toBe(
        current.id,
      );
    }
  });
});

describe("purge snapshots", () => {
  const snowflake = (date: number) =>
    ((BigInt(date - 1_420_070_400_000) << 22n) + 1n).toString();

  test("bulk-deletes only confirmed recent IDs and individually deletes old IDs", async () => {
    const f = fixture();
    const recent = [
      snowflake(Date.now() - 10_000),
      snowflake(Date.now() - 20_000),
    ];
    const old = snowflake(Date.now() - 20 * 86_400_000);
    const action = f.action("purge", {
      count: 3,
      messageIds: [...recent, old],
    });
    await expect(f.engine.execute(action)).resolves.toBe(
      "Удалено 3 сообщений.",
    );
    expect(f.channel.bulkDelete.mock.calls[0]![0]).toEqual(recent);
    expect(f.channel.messages.delete.mock.calls.map(([id]) => id)).toEqual([
      old,
    ]);
  });

  test("persists partial progress and classifies an uncertain network failure", async () => {
    const f = fixture();
    const ids = [
      snowflake(Date.now() - 20 * 86_400_000),
      snowflake(Date.now() - 21 * 86_400_000),
    ];
    f.channel.messages.delete
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"));
    const action = f.action("purge", { count: 2, messageIds: ids });
    let failure: unknown;
    try {
      await f.engine.execute(action);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PurgePartialError);
    expect(isPermanentError(failure)).toBe(false);
    expect(f.store.getAction(action.id)?.result).toContain("Удалено 1 из 2");
  });

  test("an HTTP timeout cannot be reported as a definitely failed deletion", async () => {
    const f = fixture();
    const action = f.action("purge", {
      count: 1,
      messageIds: [snowflake(Date.now() - 20 * 86_400_000)],
    });
    f.channel.messages.delete.mockRejectedValueOnce({ status: 408 });
    let failure: unknown;
    try {
      await f.engine.execute(action);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PurgePartialError);
    expect((failure as PurgePartialError).uncertain).toBe(true);
    expect(isPermanentError(failure)).toBe(false);
  });
});

test("audit reasons fit Discord limits and error messages never echo unknown network data", () => {
  const f = fixture();
  const action = f.action("ban", { reason: "x".repeat(1000) });
  expect(auditReason(action).length).toBeLessThanOrEqual(512);
  expect(auditReason(action)).toContain(caseMarker(action.id));
  expect(errorMessage(new Error("secret-token"))).not.toContain("secret-token");
});
