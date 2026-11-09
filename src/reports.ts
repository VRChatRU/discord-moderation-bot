import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type RESTGetAPIGuildMessagesSearchResult,
} from "discord.js";
import { Archive, snapshot } from "./archive.ts";
import type { Control } from "./control.ts";
import { fetchGuild, fetchMember, UserFacingError } from "./moderation.ts";
import {
  errorCode,
  errorStatus,
  noMentions,
  type Notifications,
} from "./notifications.ts";
import type { Store } from "./store.ts";
import type { Config, Logger, MessageSnapshot, ReportInput } from "./types.ts";
import { logNotice } from "./ui.ts";

const MODAL_LIFETIME = 15 * 60_000;
const REPORT_COOLDOWN = 30_000;

export async function searchAuthorMessages(
  client: Pick<Client, "rest">,
  guildId: string,
  authorId: string,
): Promise<MessageSnapshot[]> {
  const query = new URLSearchParams({
    author_id: authorId,
    limit: "10",
    sort_by: "timestamp",
    sort_order: "desc",
    include_nsfw: "true",
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = (await client.rest.get(Routes.guildMessagesSearch(guildId), {
      query,
    })) as RESTGetAPIGuildMessagesSearchResult;
    if ("messages" in result) {
      const unique = new Map<string, MessageSnapshot>();
      for (const message of result.messages.flat()) {
        // Filter defensively: search groups can contain context messages in older API responses.
        if (message.author.id !== authorId) continue;
        const data = snapshot(message);
        unique.set(data.id, data);
      }
      return [...unique.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10);
    }
    const delay = Number(result.retry_after);
    if (attempt === 2 || !Number.isFinite(delay) || delay > 3 || delay < 0)
      throw new Error("Guild message search is not indexed yet");
    await Bun.sleep(Math.max(250, delay * 1000));
  }
  throw new Error("Guild message search unavailable");
}

export class Reports {
  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly control: Control,
    private readonly notifications: Notifications,
    private readonly archive: Archive,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  private async readable(
    guildId: string | null,
    channelId: string | null,
    userId: string,
  ): Promise<void> {
    if (guildId !== this.config.guildId || !channelId)
      throw new UserFacingError(
        "Жалобы доступны только на настроенном сервере.",
      );
    const guild = await fetchGuild(this.client, guildId);
    const [member, channel] = await Promise.all([
      fetchMember(guild, userId),
      guild.channels.fetch(channelId, { force: true }),
    ]);
    if (
      !member ||
      !channel?.isTextBased() ||
      !member
        .permissionsIn(channel)
        .has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ])
    ) {
      throw new UserFacingError(
        "У вас больше нет доступа к исходному сообщению.",
      );
    }
  }

  async open(interaction: MessageContextMenuCommandInteraction): Promise<void> {
    // Discord supplies effective channel permissions with the interaction; avoid REST before the three-second modal deadline.
    if (
      interaction.guildId !== this.config.guildId ||
      !interaction.channelId ||
      !interaction.memberPermissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ])
    ) {
      throw new UserFacingError("Нет доступа к сообщению.");
    }
    const message = snapshot(interaction.targetMessage);
    const now = Date.now();
    const input: ReportInput = {
      id: crypto.randomUUID(),
      interactionId: interaction.id,
      guildId: this.config.guildId,
      channelId: message.channelId,
      messageId: message.id,
      targetId: message.authorId,
      reporterId: interaction.user.id,
      reason: null,
      message,
      context: [],
      createdAt: now,
      reporterName:
        interaction.user.globalName ||
        interaction.user.username ||
        interaction.user.id,
    };
    const author = interaction.targetMessage.author;
    if (typeof author.displayAvatarURL === "function") {
      input.targetAvatarUrl = author.displayAvatarURL();
    } else if (author.avatar) {
      input.targetAvatarUrl = `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png`;
    }
    if (this.control.recentDraftCount(input.reporterId, now - REPORT_COOLDOWN))
      throw new UserFacingError("Повторите через 30 секунд.");
    this.control.draft(input, now + MODAL_LIFETIME);
    this.archive.saveSnapshot(message, input.guildId);
    const modal = new ModalBuilder()
      .setCustomId(`report-submit:${input.id}`)
      .setTitle("Зарепортить пользователя")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("Причина жалобы")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Можно оставить пустым")
            .setRequired(false)
            .setMaxLength(1000),
        ),
      );
    await interaction.showModal(modal);
    this.logger.info("Report reason requested", {
      reportId: input.id,
      reporterId: input.reporterId,
      targetId: input.targetId,
    });
  }

  async submit(interaction: ModalSubmitInteraction): Promise<void> {
    const acknowledged = await this.acknowledge(interaction);
    const id = interaction.customId.slice("report-submit:".length);
    const draft = this.control.getDraft(id, interaction.user.id);
    if (!draft || draft.state !== "modal" || draft.expiresAt <= Date.now())
      throw new UserFacingError("Форма устарела.");
    await this.readable(
      interaction.guildId,
      draft.input.channelId,
      interaction.user.id,
    );
    const reason = interaction.fields.getTextInputValue("reason").trim();
    if (reason.length > 1000)
      throw new UserFacingError(
        "Причина должна быть не длиннее 1000 символов.",
      );
    const input: ReportInput = {
      ...draft.input,
      reason: reason || null,
      createdAt: Date.now(),
    };
    let contextWarning: string | null = null;
    try {
      input.context = await searchAuthorMessages(
        this.client,
        input.guildId,
        input.targetId,
      );
      for (const message of input.context)
        this.archive.saveSnapshot(message, input.guildId);
    } catch (error) {
      input.context = this.archive.recentGuild(
        input.guildId,
        input.targetId,
        10,
      );
      contextWarning = `Поиск недоступен: сохранено ${input.context.length} из 10 сообщений.`;
      this.store.audit("report_context_fallback", {
        reportId: input.id,
        available: input.context.length,
      });
      this.logger.warn("Report uses archived message context", {
        reportId: input.id,
        available: input.context.length,
        error,
      });
    }
    if (contextWarning) input.contextWarning = contextWarning;
    // Search can take time; recheck source access immediately before persisting the report.
    await this.readable(
      interaction.guildId,
      input.channelId,
      interaction.user.id,
    );
    const claimed = this.control.submitDraft(input, () => {
      this.store.db.transaction(() => {
        this.store.createReport(input);
        this.store.enqueue(
          "report",
          { reportId: input.id },
          `report:${input.id}`,
        );
      })();
    });
    if (!claimed)
      throw new UserFacingError("Эта форма уже обработана или устарела.");
    this.logger.info("Report submitted", {
      reportId: input.id,
      reporterId: input.reporterId,
      targetId: input.targetId,
    });
    // The complaint is already committed. A missing Discord receipt must not undo or hide it.
    try {
      if (!acknowledged && !interaction.deferred && !interaction.replied) {
        const original = await interaction.fetchReply();
        if (!original.flags.has(MessageFlags.Ephemeral))
          throw new Error("Report receipt is not private");
        // Discord can accept a response while returning 10062. Restore local state only after proving it exists.
        interaction.replied = true;
        interaction.ephemeral = true;
      }
      await interaction.editReply({
        embeds: [logNotice("Жалоба отправлена.")],
        allowedMentions: noMentions,
        components: [],
      });
    } catch (error) {
      this.logger.warn("Report submitted without a private receipt", {
        reportId: input.id,
        interactionId: interaction.id,
        code: errorCode(error),
        status: errorStatus(error),
      });
    }
    await this.notifications.tick();
  }

  private async acknowledge(
    interaction: ModalSubmitInteraction,
  ): Promise<boolean> {
    const started = performance.now();
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return true;
    } catch (error) {
      if (errorCode(error) !== 10062) throw error;
      this.logger.warn("Report acknowledgement rejected", {
        interactionId: interaction.id,
        code: errorCode(error),
        elapsedMs: Math.round(performance.now() - started),
      });
    }
    try {
      await interaction.reply({
        embeds: [logNotice("Отправляем жалобу…")],
        flags: MessageFlags.Ephemeral,
        allowedMentions: noMentions,
      });
      return true;
    } catch (error) {
      this.logger.warn("Report acknowledgement could not be recovered", {
        interactionId: interaction.id,
        code: errorCode(error),
        status: errorStatus(error),
        elapsedMs: Math.round(performance.now() - started),
      });
      // Only report submission may continue without an ACK: ownership, access and the single-submit claim are still checked.
      return false;
    }
  }

  async confirm(
    interaction: ButtonInteraction,
    id: string,
    _cancel: boolean,
  ): Promise<void> {
    await interaction.deferUpdate();
    // Restarted RAM drafts are intentionally gone; old buttons can only clear their private reply.
    this.control.finishDraft(id, interaction.user.id, "expired");
    this.control.forgetConfirmation(id);
    await interaction.editReply({
      embeds: [logNotice("Форма устарела. Отправьте жалобу заново.")],
      components: [],
      allowedMentions: noMentions,
    });
  }
}
