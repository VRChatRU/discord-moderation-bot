import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  MessageFlags,
  MessageFlagsBitField,
  type Client,
  type Interaction,
} from "discord.js";
import {
  EphemeralExpired,
  EphemeralReplies,
  ephemeralLifetime,
} from "../src/ephemeral.ts";
import { Control } from "../src/control.ts";
import { Store } from "../src/store.ts";

const appId = "123456789012345670";
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  let clock = 1_800_000_000_000;
  const remove = mock(async (_route: string, _options: unknown) => {});
  const client = {
    user: { id: appId },
    application: { id: appId },
    rest: { delete: remove },
  } as unknown as Client;
  const logger = {
    info: mock(() => {}),
    warn: mock((_message: string, _data?: unknown) => {}),
    error: mock(() => {}),
    close: async () => {},
  };
  const cleanup = new EphemeralReplies(client, store, logger, () => clock);
  const interaction = (
    options: {
      id?: string;
      source?: "public" | "private";
      origin?: string;
    } = {},
  ) => {
    const calls = {
      reply: mock(async (_options: unknown) => {}),
      deferReply: mock(async (_options: unknown) => {}),
      editReply: mock(async (_options: unknown) => {}),
      deferUpdate: mock(async () => {}),
      update: mock(async (_options: unknown) => {}),
      showModal: mock(async (_modal: unknown) => {}),
    };
    return {
      id: options.id ?? crypto.randomUUID(),
      applicationId: appId,
      token: `secret-${crypto.randomUUID()}`,
      createdTimestamp: clock,
      isRepliable: () => true,
      ...calls,
      calls,
      ...(options.source
        ? {
            message: {
              id: "source-message",
              applicationId: appId,
              author: { id: appId },
              flags: new MessageFlagsBitField(
                options.source === "private" ? MessageFlags.Ephemeral : 0,
              ),
              interactionMetadata: { id: options.origin ?? "original" },
            },
          }
        : {}),
    };
  };
  const watch = (value: ReturnType<typeof interaction>) => {
    cleanup.watch(value as unknown as Interaction);
    return value;
  };
  const rows = () =>
    store.db
      .query<
        {
          id: string;
          expires_at: number;
          state: string;
          token: string;
          attempts: number;
        },
        []
      >("SELECT * FROM ephemeral_replies")
      .all();
  return {
    store,
    client,
    logger,
    cleanup,
    remove,
    interaction,
    watch,
    rows,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("private reply lifetime", () => {
  test("deletes an ephemeral reply at 30 seconds and renews the timer after editing", async () => {
    const f = fixture();
    const interaction = f.watch(f.interaction());
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    expect(f.rows()[0]?.expires_at).toBe(f.now() + ephemeralLifetime);
    f.advance(20_000);
    await interaction.editReply({ content: "Done" });
    f.advance(29_999);
    await f.cleanup.tick();
    expect(f.remove).not.toHaveBeenCalled();
    f.advance(1);
    await f.cleanup.tick();
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.remove.mock.calls[0]).toEqual([
      `/webhooks/${appId}/${interaction.token}/messages/%40original`,
      { auth: false },
    ]);
    expect(f.rows()[0]?.state).toBe("deleted");
    expect(f.rows()[0]?.token).toBe("");
  });

  test("does not schedule modals or public messages for deletion", async () => {
    const f = fixture();
    const modal = f.watch(f.interaction());
    await modal.showModal({ title: "Reason" });
    const publicMessage = f.watch(f.interaction({ source: "public" }));
    await publicMessage.deferUpdate();
    await publicMessage.editReply({ content: "Public report" });
    const publicReply = f.watch(f.interaction());
    await publicReply.reply({ content: "Public" });
    expect(f.rows()).toHaveLength(0);
    f.advance(60_000);
    await f.cleanup.tick();
    expect(f.remove).not.toHaveBeenCalled();
  });

  test("a private receipt on a public report deletes only the new private response", async () => {
    const f = fixture();
    const interaction = f.watch(f.interaction({ source: "public" }));
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({ content: "Resolved" });
    f.advance(30_000);
    await f.cleanup.tick();
    expect(f.rows()[0]?.id).toBe(interaction.id);
    expect(f.remove.mock.calls[0]![0]).toContain(interaction.token);
    expect(f.remove.mock.calls[0]![0]).not.toContain("source-message");
  });

  test("private button updates renew the original reply rather than leaving an earlier deletion job", async () => {
    const f = fixture();
    const original = f.watch(f.interaction({ id: "original" }));
    await original.reply({ flags: MessageFlags.Ephemeral });
    f.advance(20_000);
    const button = f.watch(
      f.interaction({ source: "private", origin: original.id }),
    );
    await button.deferUpdate();
    await button.editReply({ content: "Next page" });
    expect(f.rows()).toHaveLength(1);
    expect(f.rows()[0]?.token).toBe(button.token);
    f.advance(10_000);
    await f.cleanup.tick();
    expect(f.remove).not.toHaveBeenCalled();
    f.advance(20_000);
    await f.cleanup.tick();
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  test("a private button ACK bypasses an older edit and its deadline starts at the ACK", async () => {
    const f = fixture();
    const original = f.watch(f.interaction({ id: "original" }));
    await original.reply({ flags: MessageFlags.Ephemeral });
    f.advance(10_000);
    const gate = Promise.withResolvers<void>();
    original.calls.editReply.mockImplementationOnce(() => gate.promise);
    const edit = original.editReply({ content: "Slow page" });
    await Bun.sleep(0);
    const button = f.watch(
      f.interaction({ source: "private", origin: original.id }),
    );
    const acknowledge = button.deferUpdate();
    await Bun.sleep(0);
    expect(button.calls.deferUpdate).toHaveBeenCalledTimes(1);
    const deadline = f.now() + ephemeralLifetime;
    f.advance(5000);
    gate.resolve();
    await Promise.all([edit, acknowledge]);
    expect(f.rows()[0]?.expires_at).toBe(deadline);
    expect(f.rows()[0]?.token).toBe(button.token);
    f.advance(25_000);
    await f.cleanup.tick();
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  test("expired and deleted source replies can be ACKed without reviving them", async () => {
    const f = fixture();
    const original = f.watch(f.interaction({ id: "original" }));
    await original.reply({ flags: MessageFlags.Ephemeral });
    const deadline = f.rows()[0]!.expires_at;
    f.advance(30_000);
    const expired = f.watch(
      f.interaction({ source: "private", origin: original.id }),
    );
    await expired.deferUpdate();
    expect(expired.calls.deferUpdate).toHaveBeenCalledTimes(1);
    expect(f.rows()[0]?.expires_at).toBe(deadline);
    await f.cleanup.tick();
    const deleted = f.watch(
      f.interaction({ source: "private", origin: original.id }),
    );
    await deleted.deferUpdate();
    expect(deleted.calls.deferUpdate).toHaveBeenCalledTimes(1);
    expect(f.rows()[0]?.state).toBe("deleted");
    expect(f.rows()[0]?.token).toBe("");
    expect(f.rows()[0]?.expires_at).toBe(deadline);
  });

  test("cleanup can finish while a button ACK is in flight and bookkeeping never revives it", async () => {
    const f = fixture();
    const original = f.watch(f.interaction({ id: "original" }));
    await original.reply({ flags: MessageFlags.Ephemeral });
    f.advance(29_000);
    const gate = Promise.withResolvers<void>();
    const button = f.interaction({ source: "private", origin: original.id });
    button.calls.deferUpdate.mockImplementationOnce(() => gate.promise);
    f.watch(button);
    const acknowledge = button.deferUpdate();
    f.advance(1000);
    const cleanup = f.cleanup.tick();
    await Bun.sleep(0);
    expect(f.remove).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([cleanup, acknowledge]);
    expect(f.rows()[0]?.state).toBe("deleted");
    expect(f.rows()[0]?.token).toBe("");
  });

  test("expired or deleted replies cannot be recreated by a late edit", async () => {
    const f = fixture();
    const interaction = f.watch(f.interaction());
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    f.advance(30_000);
    await expect(
      interaction.editReply({ content: "Too late" }),
    ).rejects.toBeInstanceOf(EphemeralExpired);
    expect(interaction.calls.editReply).not.toHaveBeenCalled();
    await f.cleanup.tick();
    await expect(
      interaction.editReply({ content: "Still too late" }),
    ).rejects.toBeInstanceOf(EphemeralExpired);
    expect(interaction.calls.editReply).not.toHaveBeenCalled();
  });

  test("an edit already in flight finishes before cleanup rechecks the renewed deadline", async () => {
    const f = fixture();
    const interaction = f.watch(f.interaction());
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const gate = Promise.withResolvers<void>();
    interaction.calls.editReply.mockImplementation(() => gate.promise);
    f.advance(29_000);
    const edit = interaction.editReply({ content: "Updated" });
    await Bun.sleep(0);
    f.advance(1000);
    const cleanup = f.cleanup.tick();
    gate.resolve();
    await Promise.all([edit, cleanup]);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.rows()[0]?.expires_at).toBe(f.now() + 30_000);
  });
});

describe("durable private reply cleanup", () => {
  test("recovers pending deletion after restarting the worker", async () => {
    const f = fixture();
    const interaction = f.watch(f.interaction());
    await interaction.reply({ flags: MessageFlags.Ephemeral });
    f.advance(30_000);
    const restarted = new EphemeralReplies(f.client, f.store, f.logger, f.now);
    await restarted.tick();
    expect(f.remove).toHaveBeenCalledTimes(1);
    await restarted.tick();
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  test("a lost initial response is still queued for cleanup", async () => {
    const f = fixture();
    const interaction = f.interaction();
    interaction.calls.reply.mockRejectedValueOnce(new Error("Response lost"));
    f.watch(interaction);
    await expect(
      interaction.reply({ flags: MessageFlags.Ephemeral }),
    ).rejects.toThrow("Response lost");
    expect(f.rows()).toHaveLength(1);
    f.advance(30_000);
    await f.cleanup.tick();
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  test("an initial Unknown Interaction error retains cleanup for a possible accepted response", async () => {
    const f = fixture();
    const interaction = f.watch(f.interaction());
    interaction.calls.deferReply.mockRejectedValueOnce({
      code: 10062,
      status: 404,
    });
    await expect(
      interaction.deferReply({ flags: MessageFlags.Ephemeral }),
    ).rejects.toMatchObject({ code: 10062 });
    expect(f.rows()[0]?.state).toBe("active");
    f.advance(ephemeralLifetime);
    await f.cleanup.tick();
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  test("retries a network outage without exposing webhook tokens in logs", async () => {
    const f = fixture();
    const interaction = f.watch(f.interaction());
    await interaction.reply({ flags: MessageFlags.Ephemeral });
    f.advance(30_000);
    f.remove.mockRejectedValueOnce(new Error(`Offline ${interaction.token}`));
    await f.cleanup.tick();
    expect(f.rows()[0]?.attempts).toBe(1);
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain(
      interaction.token,
    );
    await f.cleanup.tick();
    expect(f.remove).toHaveBeenCalledTimes(1);
    f.advance(1000);
    await f.cleanup.tick();
    expect(f.remove).toHaveBeenCalledTimes(2);
    expect(f.rows()[0]?.state).toBe("deleted");
  });

  test("an already deleted reply completes cleanup without endless retries", async () => {
    const f = fixture();
    const interaction = f.watch(f.interaction());
    await interaction.reply({ flags: MessageFlags.Ephemeral });
    f.advance(30_000);
    f.remove.mockRejectedValue({ status: 404, code: 10008 });
    await f.cleanup.tick();
    f.advance(60_000);
    await f.cleanup.tick();
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.rows()[0]?.state).toBe("deleted");
  });

  test("expired webhook tombstones are removed without allowing a late edit", async () => {
    const f = fixture();
    const interaction = f.watch(f.interaction());
    await interaction.reply({ flags: MessageFlags.Ephemeral });
    f.advance(30_000);
    await f.cleanup.tick();
    expect(f.rows()[0]?.state).toBe("deleted");
    f.advance(14 * 60_000 + 30_000);
    await f.cleanup.tick();
    expect(f.rows()).toHaveLength(0);
    await expect(
      interaction.editReply({ content: "Too late" }),
    ).rejects.toBeInstanceOf(EphemeralExpired);
    expect(interaction.calls.editReply).not.toHaveBeenCalled();
  });

  test("legacy 120-second confirmations are adopted with a maximum of 30 seconds", async () => {
    const f = fixture();
    f.cleanup.adopt("old", "legacy-token", f.now() + 120_000);
    expect(f.rows()[0]?.expires_at).toBe(f.now() + 30_000);
    f.advance(30_000);
    await f.cleanup.tick();
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  test("legacy confirmation migration leaves automatic appeal deadlines intact", () => {
    const f = fixture();
    const control = new Control(f.store);
    const create = (id: string, until: number) =>
      f.store.createAction({
        id,
        interactionId: id,
        guildId: "guild",
        actorId: "actor",
        targetId: "target",
        channelId: "channel",
        kind: "unban",
        reason: null,
        durationDays: null,
        count: null,
        reportId: null,
        createdAt: Date.now(),
        confirmUntil: until,
        messageIds: [],
      });
    const manual = create("manual", Date.now() + 120_000);
    const automatic = create("automatic", Date.now() + 365 * 86_400_000);
    f.store.db
      .query(
        "INSERT INTO confirmations(id,kind,token,expires_at) VALUES(?,'action','old',?)",
      )
      .run(manual.id, manual.confirmUntil);
    new Control(f.store);
    expect(f.store.getAction(manual.id)?.confirmUntil).toBe(
      manual.createdAt + 30_000,
    );
    expect(f.store.getAction(automatic.id)?.confirmUntil).toBe(
      automatic.confirmUntil,
    );
    expect(control.confirmations()[0]?.expires_at).toBe(
      manual.createdAt + 30_000,
    );
  });
});
