import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  PermissionsBitField,
  PermissionFlagsBits,
  MessageFlagsBitField,
  MessageFlags,
  Events,
  type Client,
  type Interaction,
} from "discord.js";
import { Bot } from "../src/bot.ts";
import { Store } from "../src/store.ts";
import type { Action, ActionKind, Config, Logger } from "../src/types.ts";

const ids = {
  guild: "123456789012345670",
  actor: "123456789012345671",
  target: "123456789012345672",
  bot: "123456789012345673",
  channel: "123456789012345674",
  role: "123456789012345675",
};
const config: Config = {
  token: "test",
  guildId: ids.guild,
  muteRoleId: ids.role,
  modLogChannelId: ids.channel,
  textLogChannelId: "760706717188489226",
  botChannelId: ids.channel,
  inviteUrl: "https://discord.gg/test",
  moderatorRoleIds: [],
  kumaUrl: "https://example.com/test",
  rules: new Map(),
  previewThreadId: ids.channel,
  scamAppealHours: 336,
  reportContext: "guild",
  killHistory: false,
};
const logger: Logger = { info() {}, warn() {}, error() {}, async close() {} };
const bots: Bot[] = [];
const stores = new Set<Store>();
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
  for (const store of stores) store.close();
  stores.clear();
  mock.restore();
});

function role(position: number) {
  return {
    position,
    comparePositionTo(other: { position: number }) {
      return position - other.position;
    },
  };
}
function member(id: string, position: number) {
  const roles = new Set<string>();
  const permissions = new PermissionsBitField(
    id === ids.target ? [] : [PermissionFlagsBits.Administrator],
  );
  return {
    id,
    joinedTimestamp: Date.now() + 60_000,
    user: { id, bot: id === ids.bot },
    permissions,
    permissionsIn: () => permissions,
    roles: {
      cache: roles,
      highest: role(position),
      add: mock(async (id: string) => {
        roles.add(id);
      }),
      remove: mock(async (id: string) => {
        roles.delete(id);
      }),
    },
    kick: mock(async () => {}),
  };
}

async function fixture() {
  const store = new Store(":memory:");
  stores.add(store);
  const actor = member(ids.actor, 50),
    target = member(ids.target, 10),
    botMember = member(ids.bot, 90);
  const members = new Map([
    [ids.actor, actor],
    [ids.target, target],
    [ids.bot, botMember],
  ]);
  const ban = mock(async (_id: string, _options: unknown) => {});
  const guild = {
    id: ids.guild,
    ownerId: "123456789012345679",
    name: "Test guild",
    members: {
      fetchMe: mock(async () => botMember),
      fetch: mock(async ({ user }: { user: string }) => {
        if (!members.has(user)) throw { status: 404, code: 10007 };
        return members.get(user)!;
      }),
      ban,
      unban: mock(async (_id: string) => {}),
    },
    bans: {
      fetch: mock(async () => {
        throw { status: 404, code: 10026 };
      }),
    },
    channels: { fetch: mock(async () => ({ isTextBased: () => true })) },
    roles: {
      fetch: mock(async () => ({
        id: ids.role,
        managed: false,
        permissions: new PermissionsBitField(),
        ...role(20),
      })),
    },
  };
  const emitter = new EventEmitter();
  const send = mock(async (_body: unknown) => {});
  const client = Object.assign(emitter, {
    user: { id: ids.bot },
    application: { id: ids.bot },
    guilds: {
      fetch: mock(async () => guild),
      cache: new Map([[ids.guild, guild]]),
    },
    users: { fetch: mock(async () => ({ send })) },
    rest: {
      patch: mock(async (_route: string, _options: unknown) => {}),
      delete: mock(async (_route: string, _options?: unknown) => {}),
      put: mock(async () => {}),
      post: mock(async () => ({ id: "message" })),
    },
    isReady: () => true,
    login: mock(async (_token: string) => "test"),
    destroy: mock(async () => {}),
  });
  const bot = new Bot(client as unknown as Client, store, config, logger);
  bots.push(bot);
  await bot.start();
  const actionDm = spyOn(bot.notifications, "actionDm").mockResolvedValue(
    false,
  );
  const execute = spyOn(bot.moderation, "execute").mockResolvedValue(
    "Действие применено.",
  );
  const command = (name: string = "ban") => {
    const interaction = {
      id: crypto.randomUUID(),
      guildId: ids.guild,
      channelId: ids.channel,
      commandName: name,
      token: "interaction-token",
      user: { id: ids.actor },
      deferred: false,
      replied: false,
      isRepliable: () => true,
      isCommand: () => true,
      isChatInputCommand: () => true,
      isButton: () => false,
      isMessageContextMenuCommand: () => false,
      isModalSubmit: () => false,
      options: {
        getUser: () => ({ id: ids.target }),
        getString: () => null,
        getNumber: () => null,
        getInteger: () => null,
      },
      deferReply: mock(async (_options?: unknown) => {
        interaction.deferred = true;
      }),
      reply: mock(async (_body: unknown) => {
        interaction.replied = true;
      }),
      editReply: mock(async (_body: unknown) => {}),
    };
    return Object.assign(interaction, {
      responses: {
        reply: interaction.reply,
        editReply: interaction.editReply,
        deferReply: interaction.deferReply,
      },
    });
  };
  const button = (customId: string) => {
    const interaction = {
      id: crypto.randomUUID(),
      guildId: ids.guild,
      channelId: ids.channel,
      customId,
      token: crypto.randomUUID(),
      message: {
        id: "report-message",
        applicationId: ids.bot,
        author: { id: ids.bot },
        flags: new MessageFlagsBitField(
          customId.startsWith("report-") ? 0 : MessageFlags.Ephemeral,
        ),
        interactionMetadata: {
          id:
            store.getAction(customId.split(":")[1] ?? "")?.interactionId ??
            "history-origin",
        },
      },
      user: { id: ids.actor },
      deferred: false,
      replied: false,
      isRepliable: () => true,
      isCommand: () => false,
      isChatInputCommand: () => false,
      isButton: () => true,
      isMessageContextMenuCommand: () => false,
      isModalSubmit: () => false,
      deferUpdate: mock(async () => {
        interaction.deferred = true;
      }),
      deferReply: mock(async (_options?: unknown) => {
        interaction.deferred = true;
      }),
      reply: mock(async (_body: unknown) => {
        interaction.replied = true;
      }),
      editReply: mock(async (_body: unknown) => {}),
    };
    return Object.assign(interaction, {
      responses: {
        reply: interaction.reply,
        editReply: interaction.editReply,
        deferReply: interaction.deferReply,
      },
    });
  };
  const prepare = async (kind: ActionKind = "ban") => {
    const interaction = command(kind);
    await bot.handle(interaction as unknown as Interaction);
    return store.listActions(ids.target, ids.guild)[0]!;
  };
  const seed = (kind: ActionKind, changes: Partial<Action> = {}) =>
    store.createAction({
      id: crypto.randomUUID(),
      interactionId: crypto.randomUUID(),
      guildId: ids.guild,
      actorId: ids.actor,
      targetId: ids.target,
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
  const internals = bot as unknown as {
    cleanConfirmations(): Promise<void>;
    expire(): Promise<void>;
    recover(): Promise<void>;
    maintenance(): Promise<void>;
    muteRemoved(id: string): Promise<void>;
    queueMuteRestore(id: string): boolean;
    reapplyMute(id: string): Promise<void>;
  };
  return {
    store,
    actor,
    target,
    botMember,
    members,
    guild,
    client,
    bot,
    send,
    actionDm,
    execute,
    command,
    button,
    prepare,
    seed,
    internals,
  };
}

describe("interaction transport recovery", () => {
  test("terminal callback errors stay in the diagnostic log without another reply or moderation warning", async () => {
    for (const code of [10062, 40060]) {
      const f = await fixture();
      const warn = spyOn(logger, "warn");
      const failure = spyOn(logger, "error");
      const notification = spyOn(f.bot.notifications, "log");
      const interaction = f.command();
      interaction.responses.deferReply.mockRejectedValueOnce({
        code,
        status: code === 10062 ? 404 : 400,
      });
      f.client.emit(
        Events.InteractionCreate,
        interaction as unknown as Interaction,
      );
      await Promise.allSettled([
        ...(f.bot as unknown as { tasks: Set<Promise<unknown>> }).tasks,
      ]);
      expect(interaction.responses.reply).not.toHaveBeenCalled();
      expect(interaction.responses.editReply).not.toHaveBeenCalled();
      expect(notification).not.toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "Interaction response unavailable",
        expect.objectContaining({
          interactionId: interaction.id,
          elapsedMs: expect.any(Number),
        }),
      );
      expect(f.store.listActions(ids.target, ids.guild)).toHaveLength(0);
      warn.mockRestore();
      failure.mockRestore();
    }
  });

  test("a real report event still reaches mod-log when both initial receipt attempts fail", async () => {
    const f = await fixture();
    Object.assign(f.client.rest, { get: mock(async () => ({ messages: [] })) });
    const showModal = mock(
      async (_value: { data: { custom_id: string } }) => {},
    );
    await f.bot.handle({
      ...f.command(),
      commandName: "Зарепортить пользователя",
      memberPermissions: f.actor.permissions,
      isChatInputCommand: () => false,
      isMessageContextMenuCommand: () => true,
      targetMessage: {
        id: "123456789012345680",
        channelId: ids.channel,
        author: { id: ids.target, tag: "User42", avatar: null },
        content: "Reported content",
        attachments: new Map(),
        createdTimestamp: Date.now(),
      },
      showModal,
    } as unknown as Interaction);
    const customId = showModal.mock.calls[0]![0].data.custom_id;
    const interaction = {
      ...f.command(),
      customId,
      isCommand: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => true,
      fields: { getTextInputValue: () => "Спам" },
      fetchReply: mock(async () => {
        throw { code: 10015, status: 404 };
      }),
    };
    interaction.responses.deferReply.mockRejectedValueOnce({
      code: 10062,
      status: 404,
    });
    interaction.responses.reply.mockRejectedValueOnce({
      code: 10062,
      status: 404,
    });
    const failure = spyOn(logger, "error");
    f.client.emit(
      Events.InteractionCreate,
      interaction as unknown as Interaction,
    );
    await Promise.allSettled([
      ...(f.bot as unknown as { tasks: Set<Promise<unknown>> }).tasks,
    ]);
    const report = f.store.getReport(customId.slice("report-submit:".length));
    expect(report?.reason).toBe("Спам");
    expect(report?.modMessageId).toBe("message");
    expect(f.client.rest.post).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
    expect(f.store.dueOutbox()).toHaveLength(0);
    const cleanup = f.store.db
      .query<{ state: string }, [string]>(
        "SELECT state FROM ephemeral_replies WHERE id=?",
      )
      .get(interaction.id);
    expect(cleanup?.state).toBe("active");
  });
});

describe("shared application interaction ownership", () => {
  test("foreign commands, menus, modals and buttons are ignored before any acknowledgment or logging", async () => {
    const f = await fixture();
    const watch = spyOn(f.bot.ephemeral, "watch");
    const notify = spyOn(f.bot.notifications, "log");
    const recorded = spyOn(logger, "info");
    const foreign = [
      f.command("say"),
      {
        ...f.command("Чужое контекстное меню"),
        isChatInputCommand: () => false,
        isMessageContextMenuCommand: () => true,
      },
      {
        ...f.command(),
        customId: "banner-upload:draft",
        isCommand: () => false,
        isChatInputCommand: () => false,
        isModalSubmit: () => true,
      },
      f.button("sticky:channel"),
      f.button("report-foreign:draft"),
      f.button("confirm:"),
      f.button("logs:invalid:page"),
    ];
    for (const interaction of foreign) {
      await f.bot.handle(interaction as unknown as Interaction);
      for (const response of Object.values(interaction.responses))
        expect(response).not.toHaveBeenCalled();
      if ("deferUpdate" in interaction)
        expect(interaction.deferUpdate).not.toHaveBeenCalled();
    }
    expect(watch).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(recorded).not.toHaveBeenCalled();
    expect(
      f.store.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM ephemeral_replies",
        )
        .get()?.count,
    ).toBe(0);
    expect(f.store.listActions(ids.target, ids.guild)).toHaveLength(0);
  });

  test("foreign interactions remain silent even when inactive or invoked in a different guild", async () => {
    const f = await fixture();
    await f.bot.stop();
    const watch = spyOn(f.bot.ephemeral, "watch");
    const recorded = spyOn(logger, "info");
    const foreign = f.command("say");
    foreign.guildId = "other-guild";
    await f.bot.handle(foreign as unknown as Interaction);
    for (const response of Object.values(foreign.responses))
      expect(response).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(recorded).not.toHaveBeenCalled();
  });
});

describe("moderator interaction routing", () => {
  test("confirmation validity is 30 seconds and paging cannot extend its deadline", async () => {
    const f = await fixture();
    const action = await f.prepare();
    expect(action.confirmUntil - action.createdAt).toBe(30_000);
    await f.bot.handle(
      f.button(`logs:${ids.target}:0`) as unknown as Interaction,
    );
    expect(f.store.getAction(action.id)?.confirmUntil).toBe(
      action.confirmUntil,
    );
  });

  test("a long-running moderation action completes even after its private reply expires", async () => {
    const f = await fixture();
    const action = await f.prepare();
    const gate = Promise.withResolvers<string>();
    f.execute.mockReturnValueOnce(gate.promise);
    const interaction = f.button(`confirm:${action.id}`);
    const running = f.bot.handle(interaction as unknown as Interaction);
    while (!f.execute.mock.calls.length) await Bun.sleep(0);
    f.store.db
      .query(
        "UPDATE ephemeral_replies SET expires_at=0,next_attempt_at=0 WHERE state='active'",
      )
      .run();
    await f.bot.ephemeral.tick();
    gate.resolve("Applied");
    await running;
    expect(f.store.getAction(action.id)?.state).toBe("succeeded");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(interaction.responses.editReply).toHaveBeenCalledTimes(1);
    expect(f.client.rest.delete).toHaveBeenCalledTimes(1);
  });

  test("permission denial cannot prepare or execute an action", async () => {
    const f = await fixture();
    f.actor.permissions.remove(PermissionFlagsBits.Administrator);
    await expect(
      f.bot.handle(f.command() as unknown as Interaction),
    ).rejects.toThrow("нет прав");
    expect(f.store.listActions(ids.target, ids.guild)).toHaveLength(0);
    expect(f.execute).not.toHaveBeenCalled();
  });

  test("a failed target validation persists a failed action, never a pending action", async () => {
    const f = await fixture();
    f.target.roles.cache.add(ids.role);
    await expect(
      f.bot.handle(f.command("mute") as unknown as Interaction),
    ).rejects.toThrow("уже есть роль");
    expect(f.store.listActions(ids.target, ids.guild)[0]?.state).toBe("failed");
  });

  test("two confirmations execute exactly once", async () => {
    const f = await fixture();
    const action = await f.prepare();
    await Promise.all([
      f.bot.handle(f.button(`confirm:${action.id}`) as unknown as Interaction),
      f.bot.handle(f.button(`confirm:${action.id}`) as unknown as Interaction),
    ]);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.store.getAction(action.id)?.state).toBe("succeeded");
  });

  test("a cancellation racing an in-flight confirmation cannot overwrite its result", async () => {
    const f = await fixture();
    const action = await f.prepare();
    const gate = Promise.withResolvers<string>();
    f.execute.mockReturnValueOnce(gate.promise);
    const confirmed = f.bot.handle(
      f.button(`confirm:${action.id}`) as unknown as Interaction,
    );
    while (!f.execute.mock.calls.length) await Bun.sleep(0);
    const cancelled = f.bot.handle(
      f.button(`cancel:${action.id}`) as unknown as Interaction,
    );
    gate.resolve("Applied");
    await Promise.all([confirmed, cancelled]);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.store.getAction(action.id)?.state).toBe("succeeded");
  });

  test("cancelling first prevents any later confirmation from executing", async () => {
    const f = await fixture();
    const action = await f.prepare();
    await f.bot.handle(
      f.button(`cancel:${action.id}`) as unknown as Interaction,
    );
    await f.bot.handle(
      f.button(`confirm:${action.id}`) as unknown as Interaction,
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.getAction(action.id)?.state).toBe("cancelled");
  });

  test("revoked permissions are checked again at confirmation", async () => {
    const f = await fixture();
    const action = await f.prepare();
    f.actor.permissions.remove(PermissionFlagsBits.Administrator);
    await f.bot.handle(
      f.button(`confirm:${action.id}`) as unknown as Interaction,
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.getAction(action.id)?.state).toBe("failed");
  });

  test("expired confirmations cannot execute", async () => {
    const f = await fixture();
    const action = await f.prepare();
    f.store.db
      .query(
        "UPDATE actions SET confirm_until=0,payload=json_set(payload,'$.confirmUntil',0) WHERE id=?",
      )
      .run(action.id);
    await f.bot.handle(
      f.button(`confirm:${action.id}`) as unknown as Interaction,
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.getAction(action.id)?.state).toBe("expired");
  });

  test("failed ephemeral edits cannot strand or falsely cancel a confirmed action", async () => {
    const f = await fixture();
    const action = await f.prepare();
    const interaction = f.button(`confirm:${action.id}`);
    interaction.editReply.mockRejectedValue(new Error("offline"));
    await f.bot.handle(interaction as unknown as Interaction);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.store.getAction(action.id)?.state).toBe("succeeded");
    f.store.db
      .query("UPDATE confirmations SET expires_at=0 WHERE id=?")
      .run(action.id);
    await f.internals.cleanConfirmations();
    f.store.db
      .query(
        "UPDATE ephemeral_replies SET expires_at=0,next_attempt_at=0 WHERE state='active'",
      )
      .run();
    await f.bot.ephemeral.tick();
    expect(f.client.rest.patch).not.toHaveBeenCalled();
    expect(f.client.rest.delete).toHaveBeenCalledTimes(1);
  });

  test("history pagination rechecks moderator permissions", async () => {
    const f = await fixture();
    await f.bot.handle(f.command("modlogs") as unknown as Interaction);
    f.actor.permissions.remove(PermissionFlagsBits.Administrator);
    const page = f.button(`logs:${ids.target}:1`);
    await expect(f.bot.handle(page as unknown as Interaction)).rejects.toThrow(
      "нет прав",
    );
    expect(page.responses.editReply).not.toHaveBeenCalled();
  });
});

describe("report action routing", () => {
  async function report(f: Awaited<ReturnType<typeof fixture>>) {
    const input = {
      id: crypto.randomUUID(),
      interactionId: crypto.randomUUID(),
      guildId: ids.guild,
      channelId: ids.channel,
      messageId: "123456789012345676",
      targetId: ids.target,
      reporterId: ids.actor,
      reason: "spam",
      context: [],
      createdAt: Date.now(),
      message: {
        id: "123456789012345676",
        channelId: ids.channel,
        authorId: ids.target,
        authorName: "target",
        content: "spam",
        attachments: [],
        createdAt: Date.now(),
      },
    };
    f.store.createReport(input);
    f.store.setReportMessage(input.id, "report-message");
    return input;
  }

  test("resolving a report only queues its card update without another moderation message", async () => {
    const f = await fixture();
    const r = await report(f);
    const notification = spyOn(f.bot.notifications, "log");
    await f.bot.handle(
      f.button(`report-resolve:${r.id}`) as unknown as Interaction,
    );
    expect(f.store.getReport(r.id)?.state).toBe("resolved");
    expect(f.store.getReport(r.id)?.resolvedBy).toBe(ids.actor);
    expect(f.store.dueOutbox().map((item) => item.kind)).toEqual([
      "report-edit",
    ]);
    expect(notification).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  test("the original scam report button executes without a second confirmation", async () => {
    const f = await fixture();
    const r = await report(f);
    const interaction = f.button(`report-scam:${r.id}`);
    await f.bot.handle(interaction as unknown as Interaction);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]![0].kind).toBe("scam");
    expect(f.store.getReport(r.id)?.state).toBe("resolved");
    expect(f.store.db.query("SELECT * FROM confirmations").all()).toHaveLength(
      0,
    );
    expect(interaction.responses.deferReply).toHaveBeenCalledTimes(1);
  });

  test("a stale or forged copy of the report cannot ban", async () => {
    const f = await fixture();
    const r = await report(f);
    const interaction = f.button(`report-scam:${r.id}`);
    interaction.message.id = "forged";
    await expect(
      f.bot.handle(interaction as unknown as Interaction),
    ).rejects.toThrow("копия устарела");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.getReport(r.id)?.state).toBe("open");
  });

  test("a failed action insert rolls the report claim back to open", async () => {
    const f = await fixture();
    const r = await report(f);
    f.store.db.exec(
      "CREATE TRIGGER reject_scam_action BEFORE INSERT ON actions BEGIN SELECT RAISE(ABORT,'test insert failure'); END",
    );
    await expect(
      f.bot.handle(f.button(`report-scam:${r.id}`) as unknown as Interaction),
    ).rejects.toThrow("test insert failure");
    expect(f.store.getReport(r.id)?.state).toBe("open");
    expect(f.execute).not.toHaveBeenCalled();
  });
});

describe("recovery and runtime ownership", () => {
  test("a recovered unban sends its mandatory DM once", async () => {
    const f = await fixture();
    const action = f.seed("unban");
    f.store.claimAction(action.id, action.actorId);
    f.store.db
      .query("INSERT INTO reconcile_queue(action_id,next_at) VALUES(?,0)")
      .run(action.id);
    spyOn(f.bot.moderation, "reconcile").mockResolvedValue("succeeded");
    await f.internals.recover();
    await f.internals.recover();
    expect(f.store.getAction(action.id)?.state).toBe("succeeded");
    expect(f.actionDm).toHaveBeenCalledTimes(1);
  });

  test("backed-off expiry failures cannot starve a later due sanction", async () => {
    const f = await fixture();
    const expired = spyOn(f.bot.moderation, "expire").mockResolvedValue(
      "Срок бана истёк. Блокировка уже снята.",
    );
    for (let i = 0; i < 11; i++) {
      const action = f.seed("ban", {
        targetId: String(BigInt(ids.target) + BigInt(i)),
      });
      f.store.setSanction({
        guildId: ids.guild,
        targetId: action.targetId!,
        kind: "ban",
        actionId: action.id,
        roleId: null,
        expiresAt: 0,
      });
      if (i < 10)
        f.store.db
          .query("INSERT INTO expiry_retries(action_id,next_at) VALUES(?,?)")
          .run(action.id, Date.now() + 3600_000);
    }
    await f.internals.expire();
    expect(expired).toHaveBeenCalledTimes(1);
    expect(
      f.store.dueOutbox().filter((item) => item.kind === "dm"),
    ).toHaveLength(1);
  });

  test("expiry removal and its mandatory notification commit atomically", async () => {
    const f = await fixture();
    const action = f.seed("ban");
    f.store.setSanction({
      guildId: ids.guild,
      targetId: ids.target,
      kind: "ban",
      actionId: action.id,
      roleId: null,
      expiresAt: 0,
    });
    f.store.db.exec(
      "CREATE TRIGGER reject_expiry_dm BEFORE INSERT ON outbox WHEN NEW.kind='dm' BEGIN SELECT RAISE(ABORT,'queue unavailable'); END",
    );
    await f.internals.expire();
    expect(f.store.getSanction(ids.guild, ids.target, "ban")).not.toBeNull();
    f.store.db.exec("DROP TRIGGER reject_expiry_dm");
    f.store.db
      .query("UPDATE expiry_retries SET next_at=0 WHERE action_id=?")
      .run(action.id);
    await f.internals.expire();
    expect(f.store.getSanction(ids.guild, ids.target, "ban")).toBeNull();
    expect(
      f.store.dueOutbox().filter((item) => item.kind === "dm"),
    ).toHaveLength(1);
  });

  test("a second instance cannot own the same SQLite database", async () => {
    const f = await fixture();
    const second = new Bot(
      f.client as unknown as Client,
      f.store,
      config,
      logger,
    );
    bots.push(second);
    await expect(second.start()).rejects.toThrow("Another bot instance");
    expect(f.client.login).toHaveBeenCalledTimes(1);
    await f.bot.start();
    expect(f.client.login).toHaveBeenCalledTimes(1);
  });

  test("lost ownership and shutdown prevent new actions", async () => {
    const f = await fixture();
    f.store.db
      .query("UPDATE runtime_lease SET owner='other',expires_at=?")
      .run(Date.now() + 60_000);
    const interaction = f.command();
    await f.bot.handle(interaction as unknown as Interaction);
    expect(interaction.responses.reply).toHaveBeenCalledTimes(1);
    expect(f.store.listActions(ids.target, ids.guild)).toHaveLength(0);
    await f.bot.stop();
    const stopped = f.command();
    await f.bot.handle(stopped as unknown as Interaction);
    expect(stopped.responses.reply).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
  });

  test("manual role removal clears an old sanction, while a delayed event preserves a new role", async () => {
    const f = await fixture();
    const action = f.seed("mute");
    f.store.setSanction({
      guildId: ids.guild,
      targetId: ids.target,
      kind: "mute",
      actionId: action.id,
      roleId: ids.role,
      expiresAt: null,
    });
    f.target.roles.cache.add(ids.role);
    await f.internals.muteRemoved(ids.target);
    expect(f.store.getSanction(ids.guild, ids.target, "mute")).not.toBeNull();
    f.target.roles.cache.delete(ids.role);
    await f.internals.muteRemoved(ids.target);
    expect(f.store.getSanction(ids.guild, ids.target, "mute")).toBeNull();
  });

  test("a failed rejoin restoration remains queued and succeeds after connectivity recovers", async () => {
    const f = await fixture();
    const action = f.seed("mute");
    f.store.setSanction({
      guildId: ids.guild,
      targetId: ids.target,
      kind: "mute",
      actionId: action.id,
      roleId: ids.role,
      expiresAt: null,
    });
    f.internals.queueMuteRestore(ids.target);
    f.guild.members.fetch.mockRejectedValueOnce(new Error("offline"));
    await f.internals.reapplyMute(ids.target);
    expect(
      f.store.db
        .query<{ attempts: number }, [string]>(
          "SELECT attempts FROM mute_restore_queue WHERE user_id=?",
        )
        .get(ids.target)?.attempts,
    ).toBe(1);
    expect(f.store.getSanction(ids.guild, ids.target, "mute")).not.toBeNull();
    f.store.db
      .query("UPDATE mute_restore_queue SET next_at=0 WHERE user_id=?")
      .run(ids.target);
    await f.internals.maintenance();
    expect(f.target.roles.cache.has(ids.role)).toBe(true);
    expect(
      f.store.db
        .query("SELECT * FROM mute_restore_queue WHERE user_id=?")
        .get(ids.target),
    ).toBeNull();
  });

  test("startup restoration preserves a manual unmute in the same membership", async () => {
    const f = await fixture();
    const action = f.seed("mute");
    f.target.joinedTimestamp = action.createdAt - 60_000;
    f.store.setSanction({
      guildId: ids.guild,
      targetId: ids.target,
      kind: "mute",
      actionId: action.id,
      roleId: ids.role,
      expiresAt: null,
    });
    f.internals.queueMuteRestore(ids.target);
    await f.internals.reapplyMute(ids.target);
    expect(f.target.roles.add).not.toHaveBeenCalled();
    expect(f.store.getSanction(ids.guild, ids.target, "mute")).toBeNull();
  });
});

describe("gateway text-log integration", () => {
  const drain = async (bot: Bot) => {
    await Promise.allSettled([
      ...(bot as unknown as { tasks: Set<Promise<unknown>> }).tasks,
    ]);
  };

  test("routes edits, cached deletes, bulk deletes and departures to text-log and ignores events after shutdown", async () => {
    const f = await fixture();
    const message = (id: string, content: string) => ({
      id,
      guildId: ids.guild,
      channelId: ids.channel,
      partial: false,
      author: { id: ids.target, tag: "User42", bot: false },
      content,
      attachments: new Map(),
      createdTimestamp: Date.now(),
    });
    const before = message("123456789012345681", "Before");
    f.client.emit(Events.MessageCreate, before);
    await drain(f.bot);
    const after = { ...before, content: "After" };
    f.client.emit(Events.MessageUpdate, before, after);
    await drain(f.bot);
    f.client.emit(Events.MessageDelete, {
      ...after,
      partial: true,
      author: null,
    });
    await drain(f.bot);
    const others = [
      message("123456789012345682", "Second"),
      message("123456789012345683", "Third"),
    ];
    for (const item of others) f.client.emit(Events.MessageCreate, item);
    await drain(f.bot);
    f.client.emit(
      Events.MessageBulkDelete,
      new Map(others.map((item) => [item.id, item])),
      { id: ids.channel, guildId: ids.guild },
    );
    f.client.emit(Events.GuildMemberRemove, {
      id: ids.target,
      guild: { id: ids.guild },
      nickname: "User42",
      joinedTimestamp: Date.now() - 60_000,
    });
    await drain(f.bot);
    const notifications = f.store.dueOutbox(Date.now() + 60_000, 100);
    expect(notifications).toHaveLength(4);
    expect(
      notifications.every(
        (item) => item.payload.channelId === config.textLogChannelId,
      ),
    ).toBe(true);
    expect(f.bot.archive.get(before.id)?.content).toBe("After");
    const editText = JSON.stringify(notifications[0]!.payload.embeds);
    expect(editText).toContain("Before");
    expect(editText).toContain("After");
    expect(
      f.store.db
        .query<{ name: string }, []>("PRAGMA table_info(text_log_events)")
        .all()
        .some((column) => column.name === "payload"),
    ).toBe(false);
    await f.bot.stop();
    f.client.emit(
      Events.MessageDelete,
      message("123456789012345684", "Ignored"),
    );
    await drain(f.bot);
    expect(f.store.dueOutbox(Date.now() + 60_000, 100)).toHaveLength(4);
  });

  test("manual removal of a persisted mute role is noticed after the configured role changes", async () => {
    const f = await fixture();
    const action = f.seed("mute");
    const originalRole = "123456789012345680";
    f.store.setSanction({
      guildId: ids.guild,
      targetId: ids.target,
      kind: "mute",
      actionId: action.id,
      roleId: originalRole,
      expiresAt: null,
    });
    f.client.emit(
      Events.GuildMemberUpdate,
      { id: ids.target, roles: { cache: new Set([originalRole]) } },
      { ...f.target, guild: { id: ids.guild } },
    );
    await drain(f.bot);
    expect(f.store.getSanction(ids.guild, ids.target, "mute")).toBeNull();
  });
});
