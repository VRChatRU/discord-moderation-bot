import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  MessageFlags,
  MessageFlagsBitField,
  PermissionFlagsBits,
  PermissionsBitField,
  type APIMessage,
  type ButtonInteraction,
  type Client,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { Archive } from "../src/archive.ts";
import { Control } from "../src/control.ts";
import type { Notifications } from "../src/notifications.ts";
import { Reports, searchAuthorMessages } from "../src/reports.ts";
import { Store } from "../src/store.ts";
import type { Config, Logger } from "../src/types.ts";

const guildId = "123456789012345670";
const userId = "123456789012345671";
const targetId = "123456789012345672";
const channelId = "123456789012345673";
const messageId = "123456789012345674";
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const logger: Logger = { info() {}, warn() {}, error() {}, async close() {} };
const config: Config = {
  token: "test",
  guildId,
  muteRoleId: channelId,
  modLogChannelId: channelId,
  textLogChannelId: "760706717188489226",
  botChannelId: channelId,
  inviteUrl: "https://discord.gg/test",
  moderatorRoleIds: [],
  kumaUrl: "https://example.com/push",
  rules: new Map(),
  previewThreadId: channelId,
  scamAppealHours: 336,
  reportContext: "guild",
  killHistory: false,
};

function apiMessage(index: number, author = targetId): APIMessage {
  return {
    id: String(BigInt(messageId) + BigInt(index)),
    author: { id: author, username: "reported-user" },
    channel_id: channelId,
    content: `message ${index}`,
    attachments: [],
    timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  } as unknown as APIMessage;
}

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const control = new Control(store);
  const archive = new Archive(store);
  const permissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
  const member = { permissionsIn: mock((_channel: unknown) => permissions) };
  const channel = { isTextBased: () => true };
  const guild = {
    roles: { fetch: mock(async () => new Map()) },
    members: { fetch: mock(async () => member) },
    channels: {
      fetch: mock(
        async (_id?: string, _options?: { force?: boolean }) => channel,
      ),
    },
  };
  const get = mock(
    async (_route: string, _options: { query: URLSearchParams }) => ({
      messages: [[apiMessage(1)]],
      total_results: 1,
    }),
  );
  const client = {
    rest: { get },
    guilds: { fetch: mock(async () => guild) },
  } as unknown as Client;
  const tick = mock(async () => {});
  const notifications = { tick } as unknown as Notifications;
  const reports = new Reports(
    client,
    store,
    control,
    notifications,
    archive,
    config,
    logger,
  );
  const original = {
    id: messageId,
    channelId,
    author: {
      id: targetId,
      tag: "reported-user",
      avatar: null as string | null,
      displayAvatarURL: mock(
        () => "https://cdn.discordapp.com/avatars/target/avatar.png",
      ),
    },
    content: "original evidence",
    attachments: new Map(),
    createdTimestamp: Date.now(),
  };
  const openInteraction = () => ({
    id: crypto.randomUUID(),
    guildId,
    channelId,
    user: {
      id: userId,
      username: "reporter_user",
      globalName: "Reporter Display",
    },
    memberPermissions: permissions,
    targetMessage: original,
    showModal: mock(async (_modal: { data: { custom_id: string } }) => {}),
  });
  const open = async () => {
    const interaction = openInteraction();
    await reports.open(
      interaction as unknown as MessageContextMenuCommandInteraction,
    );
    return interaction.showModal.mock.calls[0]![0].data.custom_id.slice(
      "report-submit:".length,
    );
  };
  const modal = (id: string, reason = "") => {
    const interaction = {
      id: crypto.randomUUID(),
      customId: `report-submit:${id}`,
      user: { id: userId },
      guildId,
      token: "interaction-token",
      deferred: false,
      replied: false,
      ephemeral: false,
      fields: { getTextInputValue: () => reason },
      deferReply: mock(async () => {
        interaction.deferred = true;
      }),
      reply: mock(async (_value: unknown) => {
        interaction.replied = true;
      }),
      fetchReply: mock(async () => ({
        flags: new MessageFlagsBitField(MessageFlags.Ephemeral),
      })),
      editReply: mock(async (_value: unknown) => {}),
    };
    return interaction;
  };
  const button = (owner = userId) => ({
    user: { id: owner },
    guildId,
    deferUpdate: mock(async () => {}),
    editReply: mock(async (_value: unknown) => {}),
  });
  return {
    store,
    control,
    archive,
    permissions,
    member,
    channel,
    guild,
    client,
    get,
    tick,
    reports,
    original,
    openInteraction,
    open,
    modal,
    button,
  };
}

describe("guild report context", () => {
  test("retries the documented 202 indexing response before collecting evidence", async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce({ code: 110000, retry_after: 0 } as never);
    const messages = await searchAuthorMessages(f.client, guildId, targetId);
    expect(messages).toHaveLength(1);
    expect(f.get).toHaveBeenCalledTimes(2);
  });

  test("search filters by author across all guild channels and sorts/deduplicates ten messages", async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce({
      messages: [
        ...Array.from({ length: 12 }, (_, index) => [apiMessage(index)]),
        [apiMessage(8)],
        [apiMessage(30, userId)],
      ],
      total_results: 12,
    });
    const messages = await searchAuthorMessages(f.client, guildId, targetId);
    expect(messages).toHaveLength(10);
    expect(messages[0]!.content).toBe("message 11");
    expect(messages.every((message) => message.authorId === targetId)).toBe(
      true,
    );
    const [route, options] = f.get.mock.calls[0]!;
    expect(route).toBe(`/guilds/${guildId}/messages/search`);
    expect(options.query.getAll("author_id")).toEqual([targetId]);
    expect(options.query.get("limit")).toBe("10");
    expect(options.query.get("include_nsfw")).toBe("true");
    expect(options.query.has("channel_id")).toBe(false);
  });

  test("fallback preserves original evidence and labels archived context without exposing it to reporter", async () => {
    const f = fixture();
    const id = await f.open();
    f.archive.saveSnapshot(
      {
        id: "private",
        channelId: "private-channel",
        authorId: targetId,
        authorName: "target",
        content: "private-channel-evidence",
        attachments: [],
        createdAt: Date.now(),
      },
      guildId,
    );
    f.get.mockRejectedValueOnce(new Error("offline"));
    const interaction = f.modal(id);
    await f.reports.submit(interaction as unknown as ModalSubmitInteraction);
    const draft = f.control.getDraft(id, userId)!;
    expect(draft.input.message.content).toBe("original evidence");
    expect(
      draft.input.context.some(
        (message) => message.content === "private-channel-evidence",
      ),
    ).toBe(true);
    expect(draft.input.contextWarning).toContain("Поиск недоступен");
    expect(draft.input.contextWarning).toContain("2 из 10 сообщений");
    expect(JSON.stringify(interaction.editReply.mock.calls)).not.toContain(
      "private-channel-evidence",
    );
    expect(draft.state).toBe("submitted");
    expect(f.store.getReport(id)?.contextWarning).toContain("Поиск недоступен");
  });
});

describe("report ownership and direct submission", () => {
  test("a rejected defer is recovered with one private reply and the report still submits", async () => {
    const f = fixture();
    const id = await f.open();
    const interaction = f.modal(id, "Спам");
    interaction.deferReply.mockRejectedValueOnce({ code: 10062, status: 404 });
    await f.reports.submit(interaction as unknown as ModalSubmitInteraction);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply.mock.calls[0]![0]).toMatchObject({
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.fetchReply).not.toHaveBeenCalled();
    expect(f.store.getReport(id)?.reason).toBe("Спам");
    expect(f.store.dueOutbox()).toHaveLength(1);
    expect(f.tick).toHaveBeenCalledTimes(1);
  });

  test("an expired callback cannot discard an authorized report or make duplicate submissions", async () => {
    const f = fixture();
    const id = await f.open();
    const submissions = [f.modal(id, "Спам"), f.modal(id, "Спам")];
    for (const interaction of submissions) {
      interaction.deferReply.mockRejectedValueOnce({
        code: 10062,
        status: 404,
      });
      interaction.reply.mockRejectedValueOnce({ code: 10062, status: 404 });
      interaction.fetchReply.mockRejectedValueOnce({
        code: 10015,
        status: 404,
      });
    }
    const results = await Promise.allSettled(
      submissions.map((interaction) =>
        f.reports.submit(interaction as unknown as ModalSubmitInteraction),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(f.store.getReport(id)?.reason).toBe("Спам");
    expect(f.store.dueOutbox()).toHaveLength(1);
    expect(f.control.getDraft(id, userId)?.state).toBe("submitted");
    expect(f.tick).toHaveBeenCalledTimes(1);
    expect(
      submissions.every(
        (interaction) => !interaction.replied && !interaction.deferred,
      ),
    ).toBe(true);
    expect(
      submissions.every(
        (interaction) => interaction.editReply.mock.calls.length === 0,
      ),
    ).toBe(true);
  });

  test("an accepted response with a false-negative error is recovered only after fetching its private original", async () => {
    const f = fixture();
    const id = await f.open();
    const interaction = f.modal(id);
    interaction.deferReply.mockRejectedValueOnce({ code: 10062, status: 404 });
    interaction.reply.mockRejectedValueOnce({ code: 40060, status: 400 });
    interaction.fetchReply.mockImplementationOnce(async () => {
      expect(interaction.replied).toBe(false);
      expect(interaction.deferred).toBe(false);
      return { flags: new MessageFlagsBitField(MessageFlags.Ephemeral) };
    });
    await f.reports.submit(interaction as unknown as ModalSubmitInteraction);
    expect(interaction.fetchReply).toHaveBeenCalledTimes(1);
    expect(interaction.replied).toBe(true);
    expect(interaction.ephemeral).toBe(true);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(f.store.getReport(id)).not.toBeNull();
    expect(f.tick).toHaveBeenCalledTimes(1);
  });

  test("failed private receipts cannot stop delivery of a committed report", async () => {
    const f = fixture();
    const id = await f.open();
    const interaction = f.modal(id);
    interaction.editReply.mockRejectedValueOnce({ code: 10062, status: 404 });
    await f.reports.submit(interaction as unknown as ModalSubmitInteraction);
    expect(f.store.getReport(id)).not.toBeNull();
    expect(f.store.dueOutbox()).toHaveLength(1);
    expect(f.tick).toHaveBeenCalledTimes(1);
  });

  test("rejected callbacks still enforce draft ownership and fresh channel access", async () => {
    for (const invalid of ["owner", "access"] as const) {
      const f = fixture();
      const id = await f.open();
      const interaction = f.modal(id);
      interaction.deferReply.mockRejectedValueOnce({
        code: 10062,
        status: 404,
      });
      interaction.reply.mockRejectedValueOnce({ code: 10062, status: 404 });
      if (invalid === "owner") interaction.user.id = "intruder";
      else f.permissions.remove(PermissionFlagsBits.ViewChannel);
      await expect(
        f.reports.submit(interaction as unknown as ModalSubmitInteraction),
      ).rejects.toThrow();
      expect(f.store.getReport(id)).toBeNull();
      expect(f.store.dueOutbox()).toHaveLength(0);
      expect(f.tick).not.toHaveBeenCalled();
    }
  });

  test("submits directly after the optional-reason modal without confirmation buttons", async () => {
    const f = fixture();
    const id = await f.open();
    const interaction = f.modal(id, "Спам");
    await f.reports.submit(interaction as unknown as ModalSubmitInteraction);
    const payload = interaction.editReply.mock.calls[0]![0] as {
      components: unknown[];
      embeds: {
        toJSON(): {
          title?: string;
          description?: string;
          fields?: unknown;
          footer?: unknown;
          timestamp?: unknown;
        };
      }[];
    };
    const embed = payload.embeds[0]!.toJSON();
    expect(embed.title).toBeUndefined();
    expect(embed.description).toBe("Жалоба отправлена.");
    expect(payload.components).toEqual([]);
    expect(embed.fields).toBeUndefined();
    expect(embed.footer).toBeUndefined();
    expect(embed.timestamp).toBeUndefined();
    expect(f.store.getReport(id)?.reason).toBe("Спам");
    expect(f.store.getReport(id)?.reporterName).toBe("Reporter Display");
    expect(f.store.getReport(id)?.targetAvatarUrl).toBe(
      "https://cdn.discordapp.com/avatars/target/avatar.png",
    );
    const saved = f.store.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM reports WHERE id=?",
      )
      .get(id)!;
    expect(saved.payload).not.toContain("original evidence");
    expect(
      f.store.db
        .query("SELECT name FROM sqlite_master WHERE name='report_drafts'")
        .get(),
    ).toBeNull();
    expect(f.control.getDraft(id, userId)?.state).toBe("submitted");
    expect(f.tick).toHaveBeenCalledTimes(1);
    expect(
      f.store.db.query("SELECT * FROM confirmations WHERE id=?").get(id),
    ).toBeNull();
  });

  test("allows an empty reason and supports API-style author avatars", async () => {
    const f = fixture();
    Object.defineProperty(f.original.author, "displayAvatarURL", {
      value: undefined,
    });
    f.original.author.avatar = "avatar-hash";
    const id = await f.open();
    await f.reports.submit(
      f.modal(id, "   ") as unknown as ModalSubmitInteraction,
    );
    expect(f.store.getReport(id)?.reason).toBeNull();
    expect(f.store.getReport(id)?.targetAvatarUrl).toBe(
      `https://cdn.discordapp.com/avatars/${targetId}/avatar-hash.png`,
    );
  });

  test("opening a report validates supplied channel permissions without waiting for REST", async () => {
    const f = fixture();
    f.permissions.remove(PermissionFlagsBits.ViewChannel);
    const interaction = f.openInteraction();
    await expect(
      f.reports.open(
        interaction as unknown as MessageContextMenuCommandInteraction,
      ),
    ).rejects.toThrow("Нет доступа");
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(f.guild.members.fetch).not.toHaveBeenCalled();
  });

  test("rate limits report forms per user", async () => {
    const f = fixture();
    await f.open();
    await expect(f.open()).rejects.toThrow("30 секунд");
  });

  test("only the draft owner can submit", async () => {
    const f = fixture();
    const id = await f.open();
    const wrongModal = { ...f.modal(id), user: { id: "intruder" } };
    await expect(
      f.reports.submit(wrongModal as unknown as ModalSubmitInteraction),
    ).rejects.toThrow("устарела");
    expect(f.control.getDraft(id, userId)?.state).toBe("modal");
    expect(f.store.getReport(id)).toBeNull();
    await f.reports.submit(f.modal(id) as unknown as ModalSubmitInteraction);
    expect(f.store.getReport(id)).not.toBeNull();
  });

  test("concurrent modal submissions create exactly one report and one outbox item", async () => {
    const f = fixture();
    const id = await f.open();
    const results = await Promise.allSettled([
      f.reports.submit(
        f.modal(id, "spam") as unknown as ModalSubmitInteraction,
      ),
      f.reports.submit(
        f.modal(id, "spam") as unknown as ModalSubmitInteraction,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(f.store.getReport(id)?.reason).toBe("spam");
    expect(f.store.dueOutbox()).toHaveLength(1);
    expect(f.control.getDraft(id, userId)?.state).toBe("submitted");
    expect(
      f.store.db.query("SELECT * FROM confirmations WHERE id=?").get(id),
    ).toBeNull();
  });

  test("a failed queue write rolls back both report creation and the draft claim", async () => {
    const f = fixture();
    const id = await f.open();
    f.store.db.exec(
      "CREATE TRIGGER reject_report_queue BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    await expect(
      f.reports.submit(f.modal(id) as unknown as ModalSubmitInteraction),
    ).rejects.toThrow("test failure");
    expect(f.control.getDraft(id, userId)?.state).toBe("modal");
    expect(f.store.getReport(id)).toBeNull();
    f.store.db.exec("DROP TRIGGER reject_report_queue");
    await f.reports.submit(f.modal(id) as unknown as ModalSubmitInteraction);
    expect(f.store.getReport(id)).not.toBeNull();
  });

  test("legacy confirmation buttons cannot create a report and are removed", async () => {
    const f = fixture();
    const id = await f.open();
    const draft = f.control.getDraft(id, userId)!;
    f.control.updateDraft(draft.input, Date.now() + 60_000);
    const interaction = f.button();
    await f.reports.confirm(
      interaction as unknown as ButtonInteraction,
      id,
      true,
    );
    expect(f.store.getReport(id)).toBeNull();
    expect(f.store.dueOutbox()).toHaveLength(0);
    expect(f.control.getDraft(id, userId)?.state).toBe("expired");
    expect(interaction.editReply.mock.calls[0]![0]).toMatchObject({
      components: [],
    });
  });

  test("expired forms and revoked channel access cannot submit", async () => {
    const f = fixture();
    const id = await f.open();
    f.permissions.remove(PermissionFlagsBits.ViewChannel);
    await expect(
      f.reports.submit(f.modal(id) as unknown as ModalSubmitInteraction),
    ).rejects.toThrow("нет доступа");
    f.permissions.add(PermissionFlagsBits.ViewChannel);
    f.control.expireDrafts(Date.now() + 15 * 60_000);
    await expect(
      f.reports.submit(f.modal(id) as unknown as ModalSubmitInteraction),
    ).rejects.toThrow("устарела");
    expect(f.store.getReport(id)).toBeNull();
  });

  test("rechecks channel access after evidence search finishes", async () => {
    const f = fixture();
    const id = await f.open();
    f.get.mockImplementationOnce(async () => {
      f.permissions.remove(PermissionFlagsBits.ViewChannel);
      return { messages: [[apiMessage(1)]], total_results: 1 };
    });
    await expect(
      f.reports.submit(f.modal(id) as unknown as ModalSubmitInteraction),
    ).rejects.toThrow("нет доступа");
    expect(f.store.getReport(id)).toBeNull();
    expect(f.store.dueOutbox()).toHaveLength(0);
  });

  test("refreshes channel overwrites instead of trusting access cached before revocation", async () => {
    const f = fixture();
    const id = await f.open();
    let refreshed = false;
    f.guild.channels.fetch.mockImplementation(async (_id, options) => {
      refreshed = options?.force === true;
      return f.channel;
    });
    f.member.permissionsIn.mockImplementation(() =>
      refreshed ? new PermissionsBitField() : f.permissions,
    );
    await expect(
      f.reports.submit(f.modal(id) as unknown as ModalSubmitInteraction),
    ).rejects.toThrow("нет доступа");
    expect(refreshed).toBe(true);
    expect(f.store.getReport(id)).toBeNull();
  });

  test("unfinished report forms are RAM-only and cannot resume after a restart", async () => {
    const f = fixture();
    const id = await f.open();
    expect(f.control.getDraft(id, userId)?.input.message.content).toBe(
      "original evidence",
    );
    const restartedControl = new Control(f.store);
    expect(restartedControl.getDraft(id, userId)).toBeNull();
    const restartedReports = new Reports(
      f.client,
      f.store,
      restartedControl,
      { tick: f.tick } as unknown as Notifications,
      f.archive,
      config,
      logger,
    );
    await expect(
      restartedReports.submit(f.modal(id) as unknown as ModalSubmitInteraction),
    ).rejects.toThrow("Форма устарела");
    expect(
      f.store.db
        .query("SELECT name FROM sqlite_master WHERE name='report_drafts'")
        .get(),
    ).toBeNull();
    expect(f.store.getReport(id)).toBeNull();
  });
});
