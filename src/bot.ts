import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  MessageFlags,
  type Interaction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type GuildMember,
  type Message,
} from "discord.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  actionKinds,
  type Action,
  type ActionKind,
  type Config,
  type Logger,
} from "./types.ts";
import type { Store } from "./store.ts";
import { resolveReason } from "./config.ts";
import {
  Moderation,
  UserFacingError,
  errorMessage,
  isModerator,
  permissionFor,
  isPermanentError,
  fetchMember,
  fetchGuild,
} from "./moderation.ts";
import {
  Notifications,
  noMentions,
  errorCode,
  errorStatus,
  permanent,
} from "./notifications.ts";
import { Control } from "./control.ts";
import {
  EphemeralExpired,
  EphemeralReplies,
  ephemeralLifetime,
} from "./ephemeral.ts";
import { Archive } from "./archive.ts";
import { TextLog } from "./text-log.ts";
import { Appeals } from "./appeals.ts";
import { Reports } from "./reports.ts";
import { commandDefinitions, registerCommands } from "./commands.ts";
import {
  confirmation,
  actionLog,
  modlogs,
  dmNotice,
  logNotice,
  bold,
  userMention,
} from "./ui.ts";
import { startKuma } from "./kuma.ts";
import modlogsPlugin from "../plugins/modlogs.ts";

function briefError(error: unknown): string {
  return errorMessage(error).split(/(?<=[.!?])\s/u, 1)[0]!;
}

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
    rest: { timeout: 15_000, retries: 1 },
    allowedMentions: noMentions,
    sweepers: { messages: { interval: 300, lifetime: 600 } },
  });
}

export function targetId(interaction: ChatInputCommandInteraction): string {
  const selected = interaction.options.getUser("user");
  const raw = interaction.options.getString("userid")?.trim();
  if (!!selected === !!raw)
    throw new UserFacingError("Укажите ровно одно: user или userid.");
  const id = selected?.id ?? raw!;
  if (!/^[1-9]\d{16,19}$/.test(id) || BigInt(id) > 18_446_744_073_709_551_615n)
    throw new UserFacingError("Укажите корректный Discord ID пользователя.");
  return id;
}

export class Bot {
  readonly control: Control;
  readonly archive: Archive;
  readonly textLog: TextLog;
  readonly notifications: Notifications;
  readonly moderation: Moderation;
  readonly appeals: Appeals;
  readonly reports: Reports;
  readonly ephemeral: EphemeralReplies;
  private readonly shutdown = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly owner = crypto.randomUUID();
  private maintenanceBusy = false;
  private registrationBusy = false;
  private registered = false;
  private registrationAt = 0;
  private registrationAttempts = 0;
  private announced = false;
  private stopping: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  constructor(
    readonly client: Client,
    private readonly store: Store,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.control = new Control(store);
    this.ephemeral = new EphemeralReplies(client, store, logger);
    this.archive = new Archive(store);
    this.notifications = new Notifications(client, store, config, logger);
    this.textLog = new TextLog(
      client,
      store,
      this.archive,
      this.notifications,
      config,
      logger,
    );
    this.moderation = new Moderation(client, store, config, logger, () =>
      this.assertOperational(),
    );
    this.appeals = new Appeals(
      client,
      store,
      this.control,
      this.notifications,
      config,
      logger,
    );
    this.reports = new Reports(
      client,
      store,
      this.control,
      this.notifications,
      this.archive,
      config,
      logger,
    );
    store.db.exec(`
            CREATE TABLE IF NOT EXISTS reconcile_queue (action_id TEXT PRIMARY KEY,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS expiry_retries (action_id TEXT PRIMARY KEY,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS mute_restore_queue (user_id TEXT PRIMARY KEY,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
        `);
    client.on(Events.InteractionCreate, (interaction) =>
      this.track(this.handle(interaction), "Interaction failed", interaction),
    );
    client.on(Events.ClientReady, () => {
      if (!this.active || this.shutdown.signal.aborted) return;
      this.adoptConfirmations();
      this.record("gateway_ready", { userId: client.user?.id });
      this.track(this.register(), "Command registration failed");
    });
    client.on(Events.Error, (error) =>
      logger.error("Discord client error", { error }),
    );
    client.on(Events.Warn, (message) =>
      logger.warn("Discord client warning", { message }),
    );
    client.on(Events.ShardReconnecting, (shardId) =>
      this.record("gateway_reconnecting", { shardId }),
    );
    client.on(Events.ShardResume, (shardId) =>
      this.record("gateway_resumed", { shardId }),
    );
    client.on(Events.ShardDisconnect, (event, shardId) => {
      this.record("gateway_disconnected", { code: event.code, shardId });
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
        logger.error(
          "Discord rejected the connection; check token and privileged intents",
          { code: event.code },
        );
        process.exitCode = 1;
        void this.stop();
      }
    });
    client.on(Events.MessageCreate, (message) => {
      if (!this.active || this.shutdown.signal.aborted) return;
      if (message.guildId && message.guildId !== config.guildId) return;
      this.track(this.message(message), "Message processing failed");
    });
    client.on(Events.MessageUpdate, (before, message) => {
      if (!this.active || this.shutdown.signal.aborted) return;
      this.track(
        this.textLog.updated(before, message),
        "Message edit logging failed",
      );
    });
    client.on(Events.MessageDelete, (message) => {
      if (!this.active || this.shutdown.signal.aborted) return;
      this.track(
        this.textLog.deleted(message),
        "Message deletion logging failed",
      );
    });
    client.on(Events.MessageBulkDelete, (messages, channel) => {
      if (!this.active || this.shutdown.signal.aborted) return;
      this.track(
        this.textLog.bulkDeleted(
          messages.values(),
          channel.id,
          channel.guildId,
        ),
        "Bulk deletion logging failed",
      );
    });
    client.on(Events.GuildMemberAdd, (member) => {
      if (
        member.guild.id === config.guildId &&
        this.active &&
        !this.shutdown.signal.aborted &&
        this.queueMuteRestore(member.id)
      )
        this.track(this.reapplyMute(member.id), "Mute restoration failed");
    });
    client.on(Events.GuildMemberRemove, (member) => {
      if (!this.active || this.shutdown.signal.aborted) return;
      this.track(
        this.textLog.memberLeft(member),
        "Member departure logging failed",
      );
    });
    client.on(Events.GuildBanAdd, (ban) => {
      if (!this.active || this.shutdown.signal.aborted) return;
      if (ban.guild.id === config.guildId)
        this.record("guild_ban_added", { userId: ban.user.id });
    });
    client.on(Events.GuildBanRemove, (ban) => {
      if (!this.active || this.shutdown.signal.aborted) return;
      if (ban.guild.id === config.guildId)
        this.record("guild_ban_removed", { userId: ban.user.id });
    });
    client.on(Events.GuildMemberUpdate, (before, after) => {
      if (!this.active || this.shutdown.signal.aborted) return;
      if (after.guild.id !== config.guildId) return;
      const muteRoleId =
        this.store.getSanction(config.guildId, after.id, "mute")?.roleId ??
        config.muteRoleId;
      if (
        before.roles.cache.has(muteRoleId) !== after.roles.cache.has(muteRoleId)
      )
        this.record("mute_role_changed", {
          userId: after.id,
          muted: after.roles.cache.has(muteRoleId),
        });
      if (
        before.roles.cache.has(muteRoleId) &&
        !after.roles.cache.has(muteRoleId) &&
        this.active &&
        !this.shutdown.signal.aborted
      )
        this.track(
          this.muteRemoved(after.id),
          "Manual mute removal check failed",
        );
    });
  }

  private record(event: string, data: Record<string, unknown>): void {
    this.store.audit(event, data);
    this.logger.info(event, data);
  }

  private track(
    task: Promise<unknown>,
    message: string,
    interaction?: Interaction,
  ): void {
    const started = performance.now();
    const tracked = task.catch(async (error) => {
      if (error instanceof EphemeralExpired) return;
      const diagnostic = {
        error,
        interactionId: interaction?.id,
        elapsedMs: Math.round(performance.now() - started),
      };
      if (interaction && [10062, 40060].includes(errorCode(error) ?? 0)) {
        this.logger.warn("Interaction response unavailable", diagnostic);
        return;
      }
      this.logger.error(message, diagnostic);
      this.store.audit("operation_failed", {
        operation: message,
        interactionId: interaction?.id ?? null,
        code: errorCode(error) ?? null,
      });
      if (interaction?.isRepliable()) {
        const payload = {
          embeds: [logNotice(briefError(error))],
          components: [],
          allowedMentions: noMentions,
        };
        try {
          if (interaction.deferred || interaction.replied)
            await interaction.editReply(payload);
          else
            await interaction.reply({
              ...payload,
              flags: MessageFlags.Ephemeral,
            });
        } catch {
          /* The interaction may have expired during an outage. */
        }
        this.notifications.log(
          logNotice(
            `⚠️ ${userMention(interaction.user.id)}: ${briefError(error)}`,
          ),
        );
      }
    });
    this.tasks.add(tracked);
    void tracked.finally(() => this.tasks.delete(tracked));
  }

  private async requireModerator(
    userId: string,
    permission: bigint,
  ): Promise<GuildMember> {
    const guild = await fetchGuild(this.client, this.config.guildId);
    const member = await fetchMember(guild, userId);
    if (!member || !isModerator(member, this.config, permission))
      throw new UserFacingError("У вас нет прав для этого действия.");
    return member;
  }

  private operational(): boolean {
    if (!this.active || this.shutdown.signal.aborted) return false;
    const lease = this.store.db
      .query<{ owner: string; expires_at: number }, []>(
        "SELECT owner,expires_at FROM runtime_lease WHERE id=1",
      )
      .get();
    return lease?.owner === this.owner && lease.expires_at > Date.now();
  }

  private assertOperational(): void {
    if (!this.operational())
      throw new UserFacingError("Экземпляр бота неактивен.");
  }

  private async edit(
    interaction: ButtonInteraction,
    payload: Parameters<ButtonInteraction["editReply"]>[0],
  ): Promise<boolean> {
    try {
      await interaction.editReply(payload);
      return true;
    } catch (error) {
      if (error instanceof EphemeralExpired) return false;
      this.logger.warn("Interaction display update postponed", {
        interactionId: interaction.id,
        code: errorCode(error),
        status: errorStatus(error),
      });
      return false;
    }
  }

  async handle(interaction: Interaction): Promise<void> {
    // Several services share this Discord application; only the owning service may ACK an interaction.
    const owned = interaction.isChatInputCommand()
      ? interaction.commandName === "modlogs" ||
        actionKinds.includes(interaction.commandName as ActionKind)
      : interaction.isMessageContextMenuCommand()
        ? interaction.commandName === "Зарепортить пользователя"
        : interaction.isModalSubmit()
          ? /^report-submit:[^:]{1,80}$/.test(interaction.customId)
          : interaction.isButton()
            ? /^(?:confirm|cancel|report-confirm|report-cancel|report-scam|report-resolve|report-status):[^:]{1,80}$/.test(
                interaction.customId,
              ) || /^logs:[1-9]\d{16,19}:\d{1,6}$/.test(interaction.customId)
            : false;
    if (!owned) return;
    this.ephemeral.watch(interaction);
    if (!this.operational()) {
      if (interaction.isRepliable())
        await interaction.reply({
          embeds: [logNotice("Бот временно недоступен.")],
          flags: MessageFlags.Ephemeral,
        });
      return;
    }
    if (interaction.guildId !== this.config.guildId) {
      if (interaction.isRepliable())
        await interaction.reply({
          embeds: [logNotice("Команда недоступна на этом сервере.")],
          flags: MessageFlags.Ephemeral,
        });
      return;
    }
    this.record("interaction_received", {
      interactionId: interaction.id,
      userId: interaction.user.id,
      command: interaction.isCommand()
        ? interaction.commandName
        : interaction.isButton() || interaction.isModalSubmit()
          ? interaction.customId
          : "unknown",
    });
    if (
      interaction.isMessageContextMenuCommand() &&
      interaction.commandName === "Зарепортить пользователя"
    )
      return this.reports.open(interaction);
    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("report-submit:")
    )
      return this.reports.submit(interaction);
    if (interaction.isChatInputCommand()) return this.command(interaction);
    if (!interaction.isButton()) return;
    const [verb, id, page] = interaction.customId.split(":");
    if (!id) throw new UserFacingError("Кнопка недействительна.");
    if (verb === "report-confirm" || verb === "report-cancel")
      throw new UserFacingError("Форма устарела.");
    if (verb === "logs") {
      await interaction.deferUpdate();
      await this.requireModerator(
        interaction.user.id,
        PermissionFlagsBits.ModerateMembers,
      );
      if (!/^[1-9]\d{16,19}$/.test(id) || !/^\d{1,6}$/.test(page ?? ""))
        throw new UserFacingError("Неверная страница истории.");
      const index = Number(page);
      await interaction.editReply({
        ...modlogs(
          modlogsPlugin.page(this.store, this.config.guildId, id, index),
          id,
          index,
        ),
        allowedMentions: noMentions,
      });
      return;
    }
    if (verb === "confirm" || verb === "cancel")
      return this.confirm(interaction, id, verb === "cancel");
    if (verb === "report-scam" || verb === "report-resolve")
      return this.reportButton(interaction, id, verb === "report-scam");
    throw new UserFacingError("Эта кнопка больше не поддерживается.");
  }

  private async command(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === "modlogs") {
      await this.requireModerator(
        interaction.user.id,
        PermissionFlagsBits.ModerateMembers,
      );
      const id = targetId(interaction);
      await interaction.editReply({
        ...modlogs(
          modlogsPlugin.page(this.store, this.config.guildId, id),
          id,
          0,
        ),
        allowedMentions: noMentions,
      });
      return;
    }
    if (!actionKinds.includes(interaction.commandName as ActionKind))
      throw new UserFacingError("Неизвестная команда.");
    const kind = interaction.commandName as ActionKind;
    await this.requireModerator(interaction.user.id, permissionFor(kind));
    let messageIds: string[] = [];
    const count =
      kind === "purge" ? interaction.options.getInteger("number", true) : null;
    if (kind === "purge") {
      if (
        !count ||
        count < 1 ||
        count > 100 ||
        !interaction.channel?.isTextBased() ||
        !("messages" in interaction.channel)
      )
        throw new UserFacingError(
          "Укажите от 1 до 100 сообщений в текстовом канале.",
        );
      const messages = await interaction.channel.messages.fetch({
        limit: count,
        cache: false,
      });
      messageIds = [...messages.keys()];
      for (const message of messages.values()) this.archive.save(message);
      if (!messageIds.length)
        throw new UserFacingError("В канале нет сообщений для удаления.");
    }
    let reason: string | null;
    try {
      reason =
        kind === "purge" || kind === "unban" || kind === "scam"
          ? null
          : resolveReason(
              interaction.options.getString("reason"),
              this.config.rules,
            );
    } catch (error) {
      throw new UserFacingError((error as Error).message);
    }
    const now = Date.now();
    const input = {
      id: crypto.randomUUID(),
      interactionId: interaction.id,
      guildId: this.config.guildId,
      actorId: interaction.user.id,
      targetId: kind === "purge" ? null : targetId(interaction),
      channelId: interaction.channelId,
      kind,
      reason,
      durationDays: ["mute", "kill", "ban"].includes(kind)
        ? interaction.options.getNumber("duration")
        : null,
      count,
      reportId: null,
      createdAt: now,
      confirmUntil: now + ephemeralLifetime,
      messageIds,
    };
    const action = this.store.createAction(input);
    try {
      await this.moderation.validate(action);
    } catch (error) {
      this.store.db.transaction(() => {
        this.store.finishAction(action.id, "failed", errorMessage(error));
        this.notifications.actionLog(
          this.store.getAction(action.id)!,
          `action-validation:${action.id}`,
        );
        this.store.audit("action_validation_failed", {
          actionId: action.id,
          code: errorCode(error) ?? null,
        });
      })();
      throw error;
    }
    this.record("action_prepared", {
      actionId: action.id,
      kind,
      actorId: action.actorId,
      targetId: action.targetId,
      count: messageIds.length,
    });
    this.control.confirmation(
      action.id,
      "action",
      interaction.token,
      action.confirmUntil,
    );
    try {
      await interaction.editReply({
        ...confirmation(action, this.config),
        allowedMentions: noMentions,
      });
    } catch (error) {
      this.store.finishAction(
        action.id,
        "failed",
        "Не удалось показать подтверждение.",
      );
      this.notifications.actionLog(
        this.store.getAction(action.id)!,
        `action-display:${action.id}`,
      );
      throw error;
    }
  }

  private async confirm(
    interaction: ButtonInteraction,
    id: string,
    cancel: boolean,
  ): Promise<void> {
    const action = this.store.getAction(id);
    if (!action || action.actorId !== interaction.user.id)
      throw new UserFacingError("Подтверждение другого модератора.");
    await interaction.deferUpdate();
    await this.control.locked(
      `${action.guildId}:${action.targetId ?? action.channelId}`,
      async () => {
        this.assertOperational();
        const current = this.store.getAction(id)!;
        if (current.state !== "pending" || current.confirmUntil <= Date.now()) {
          if (current.state === "pending") {
            this.store.finishAction(id, "expired", "Подтверждение истекло.");
            this.notifications.actionLog(
              this.store.getAction(id)!,
              `expired:${id}`,
            );
          }
          if (
            await this.edit(interaction, {
              embeds: [actionLog(this.store.getAction(id)!)],
              components: [],
              allowedMentions: noMentions,
            })
          )
            this.control.forgetConfirmation(id);
          return;
        }
        if (cancel) {
          this.store.db.transaction(() => {
            this.store.finishAction(id, "cancelled", "Отменено.");
            this.notifications.actionLog(
              this.store.getAction(id)!,
              `cancelled:${id}`,
            );
            this.record("action_cancelled", {
              actionId: id,
              actorId: current.actorId,
            });
          })();
          if (
            await this.edit(interaction, {
              embeds: [logNotice("Отменено.")],
              components: [],
              allowedMentions: noMentions,
            })
          )
            this.control.forgetConfirmation(id);
          return;
        }
        if (!this.store.claimAction(id, interaction.user.id))
          throw new UserFacingError("Действие уже обработано.");
        // A failed ephemeral edit must never strand a claimed action before execution.
        await this.edit(interaction, {
          embeds: [logNotice("Выполняется…")],
          components: [],
          allowedMentions: noMentions,
        });
        await this.perform(this.store.getAction(id)!);
        if (
          await this.edit(interaction, {
            embeds: [actionLog(this.store.getAction(id)!)],
            components: [],
            allowedMentions: noMentions,
          })
        )
          this.control.forgetConfirmation(id);
      },
    );
  }

  private async perform(action: Action): Promise<void> {
    this.assertOperational();
    let mutationStarted = false;
    let preDm = false;
    try {
      await this.moderation.validate(action);
      if (["ban", "kill", "kick", "scam"].includes(action.kind))
        preDm = await this.notifications.actionDm(action);
      mutationStarted = true;
      const result = await this.moderation.execute(action);
      this.store.db.transaction(() => {
        this.store.finishAction(action.id, "succeeded", result);
        if (action.reportId) {
          this.store.resolveReport(
            action.reportId,
            action.actorId,
            "Скам-аккаунт заблокирован.",
          );
          this.store.enqueue(
            "report-edit",
            { reportId: action.reportId },
            `report-resolved:${action.id}`,
          );
        }
        this.notifications.actionLog(
          this.store.getAction(action.id)!,
          `action-log:${action.id}`,
        );
        if (!["ban", "kill", "kick", "scam"].includes(action.kind))
          this.notifications.queueActionDm(this.store.getAction(action.id)!);
        this.record("action_completed", {
          actionId: action.id,
          kind: action.kind,
          targetId: action.targetId,
          result,
        });
      })();
      if (!["ban", "kill", "kick", "scam"].includes(action.kind))
        await this.notifications.actionDm(this.store.getAction(action.id)!);
    } catch (error) {
      const uncertain = mutationStarted && !isPermanentError(error);
      const progress = this.store.getAction(action.id)?.result;
      this.store.db.transaction(() => {
        this.store.finishAction(
          action.id,
          uncertain ? "uncertain" : "failed",
          [progress, errorMessage(error)].filter(Boolean).join("\n"),
        );
        if (uncertain) this.queueReconciliation(action.id);
        else if (action.reportId) {
          this.store.releaseReport(action.reportId);
          this.store.enqueue("report-edit", { reportId: action.reportId });
        }
        this.notifications.actionLog(this.store.getAction(action.id)!);
        this.store.audit("action_failed", {
          actionId: action.id,
          uncertain,
          code: errorCode(error) ?? null,
        });
      })();
      this.logger.warn("Moderation action failed", {
        actionId: action.id,
        uncertain,
        error,
      });
      if (preDm && !uncertain && action.targetId)
        this.store.enqueue("dm", {
          targetId: action.targetId,
          actionId: action.id,
          template: "action-cancelled",
          embeds: [
            dmNotice(
              "Предыдущее уведомление отменено: действие не выполнено.",
            ).toJSON(),
          ],
        });
    }
  }

  private async reportButton(
    interaction: ButtonInteraction,
    id: string,
    scam: boolean,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.requireModerator(
      interaction.user.id,
      scam
        ? PermissionFlagsBits.BanMembers
        : PermissionFlagsBits.ModerateMembers,
    );
    const report = this.store.getReport(id);
    if (
      !report ||
      interaction.channelId !== this.config.modLogChannelId ||
      interaction.message.id !== report.modMessageId
    )
      throw new UserFacingError("Репорт не найден или эта копия устарела.");
    await this.control.locked(
      `${report.guildId}:${report.targetId}`,
      async () => {
        this.assertOperational();
        await this.requireModerator(
          interaction.user.id,
          scam
            ? PermissionFlagsBits.BanMembers
            : PermissionFlagsBits.ModerateMembers,
        );
        this.assertOperational();
        const current = this.store.getReport(id)!;
        if (current.state === "resolved")
          throw new UserFacingError("Репорт уже решён.");
        if (!scam) {
          this.store.db.transaction(() => {
            this.store.resolveReport(
              id,
              interaction.user.id,
              "Проверено модератором.",
            );
            this.store.enqueue("report-edit", { reportId: id });
            this.record("report_resolved", {
              reportId: id,
              actorId: interaction.user.id,
            });
          })();
          await interaction.editReply({
            embeds: [logNotice("Жалоба закрыта.")],
          });
          return;
        }
        const now = Date.now();
        const action = this.store.db.transaction(() => {
          if (!this.store.claimReport(id))
            throw new UserFacingError("Репорт уже обрабатывается.");
          const prepared = this.store.createAction({
            id: crypto.randomUUID(),
            interactionId: interaction.id,
            guildId: report.guildId,
            actorId: interaction.user.id,
            targetId: report.targetId,
            channelId: report.channelId,
            kind: "scam",
            reason: report.reason,
            durationDays: null,
            count: null,
            reportId: id,
            createdAt: now,
            confirmUntil: now + ephemeralLifetime,
            messageIds: [],
          });
          if (!this.store.claimAction(prepared.id, prepared.actorId))
            throw new UserFacingError("Действие уже обработано.");
          this.store.enqueue("report-edit", { reportId: id });
          return this.store.getAction(prepared.id)!;
        })();
        await this.perform(this.store.getAction(action.id)!);
        await interaction.editReply({
          embeds: [actionLog(this.store.getAction(action.id)!)],
          allowedMentions: noMentions,
        });
      },
    );
  }

  private async message(message: Message): Promise<void> {
    this.archive.save(message);
    this.record("message_received", {
      messageId: message.id,
      channelId: message.channelId,
      userId: message.author.id,
      direct: !message.guildId,
    });
    if (message.guildId || message.author.bot) return;
    await this.appeals.receive(message);
  }

  private queueMuteRestore(userId: string): boolean {
    const sanction = this.store.getSanction(
      this.config.guildId,
      userId,
      "mute",
    );
    if (
      !sanction ||
      (sanction.expiresAt !== null && sanction.expiresAt <= Date.now())
    )
      return false;
    this.store.db
      .query(
        "INSERT OR IGNORE INTO mute_restore_queue(user_id,next_at) VALUES(?,?)",
      )
      .run(userId, Date.now());
    return true;
  }

  private async muteRemoved(userId: string): Promise<void> {
    await this.control.locked(`${this.config.guildId}:${userId}`, async () => {
      this.assertOperational();
      const sanction = this.store.getSanction(
        this.config.guildId,
        userId,
        "mute",
      );
      if (!sanction?.roleId) return;
      const guild = await this.client.guilds.fetch(this.config.guildId);
      const member = await fetchMember(guild, userId);
      // Ignore delayed remove events when a newer mute has already re-added the role.
      if (!member || member.roles.cache.has(sanction.roleId)) return;
      this.store.db.transaction(() => {
        this.store.removeSanction(
          this.config.guildId,
          userId,
          "mute",
          sanction.actionId,
        );
        this.store.db
          .query("DELETE FROM mute_restore_queue WHERE user_id=?")
          .run(userId);
        this.record("mute_removed_manually", {
          userId,
          actionId: sanction.actionId,
        });
        this.notifications.log(
          logNotice(`С ${userMention(userId)} вручную снят мьют.`),
        );
      })();
    });
  }

  private async reapplyMute(userId: string): Promise<void> {
    await this.control.locked(`${this.config.guildId}:${userId}`, async () => {
      const queued = this.store.db
        .query<{ attempts: number }, [string]>(
          "SELECT attempts FROM mute_restore_queue WHERE user_id=?",
        )
        .get(userId);
      if (!queued) return;
      try {
        this.assertOperational();
        const sanction = this.store.getSanction(
          this.config.guildId,
          userId,
          "mute",
        );
        if (
          !sanction ||
          (sanction.expiresAt !== null && sanction.expiresAt <= Date.now()) ||
          !sanction.roleId
        ) {
          this.store.db
            .query("DELETE FROM mute_restore_queue WHERE user_id=?")
            .run(userId);
          return;
        }
        const guild = await this.client.guilds.fetch(this.config.guildId);
        const member = await fetchMember(guild, userId);
        if (member && !member.roles.cache.has(sanction.roleId)) {
          const action = this.store.getAction(sanction.actionId);
          const appliedAt = action?.completedAt ?? action?.createdAt;
          if (
            appliedAt !== undefined &&
            typeof member.joinedTimestamp === "number" &&
            member.joinedTimestamp <= appliedAt
          ) {
            // A missing role in the same membership was removed manually while the bot was offline.
            this.store.db.transaction(() => {
              this.store.removeSanction(
                this.config.guildId,
                userId,
                "mute",
                sanction.actionId,
              );
              this.store.db
                .query("DELETE FROM mute_restore_queue WHERE user_id=?")
                .run(userId);
              this.record("mute_removed_while_offline", {
                userId,
                actionId: sanction.actionId,
              });
              this.notifications.log(
                logNotice(`С ${userMention(userId)} вручную снят мьют.`),
              );
            })();
            return;
          }
          this.assertOperational();
          await member.roles.add(
            sanction.roleId,
            `Restored mute [case:${sanction.actionId}]`,
          );
          this.record("mute_restored_on_join", {
            userId,
            actionId: sanction.actionId,
          });
          this.notifications.log(
            logNotice(
              `${userMention(userId)} вернулся на сервер; мьют восстановлен.`,
            ),
          );
        }
        this.store.db
          .query("DELETE FROM mute_restore_queue WHERE user_id=?")
          .run(userId);
      } catch (error) {
        const attempts = queued.attempts + 1;
        this.store.db
          .query(
            "UPDATE mute_restore_queue SET attempts=?,next_at=? WHERE user_id=?",
          )
          .run(
            attempts,
            Date.now() +
              Math.min(3_600_000, 5_000 * 2 ** Math.min(attempts, 10)),
            userId,
          );
        if (attempts === 1 || (attempts & (attempts - 1)) === 0)
          this.logger.warn("Mute restoration postponed", {
            userId,
            attempts,
            code: errorCode(error),
          });
        if (attempts === 1)
          this.notifications.log(
            logNotice(
              `⚠️ Не удалось восстановить мьют ${userMention(userId)}; повторим позже.`,
            ),
          );
      }
    });
  }

  private queueReconciliation(id: string): void {
    this.store.db
      .query(
        "INSERT OR IGNORE INTO reconcile_queue(action_id,next_at) VALUES(?,?)",
      )
      .run(id, Date.now() + 5_000);
  }

  private async recover(): Promise<void> {
    const row = this.store.db
      .query<{ action_id: string; attempts: number }, [number]>(
        "SELECT * FROM reconcile_queue WHERE next_at<=? LIMIT 1",
      )
      .get(Date.now());
    if (!row) return;
    const action = this.store.getAction(row.action_id);
    if (
      !action ||
      !["running", "uncertain"].includes(action.state) ||
      this.appeals.isAutomatic(action.id)
    ) {
      this.store.db
        .query("DELETE FROM reconcile_queue WHERE action_id=?")
        .run(row.action_id);
      return;
    }
    try {
      await this.control.locked(
        `${action.guildId}:${action.targetId ?? action.channelId}`,
        async () => {
          this.assertOperational();
          const current = this.store.getAction(action.id);
          if (!current || !["running", "uncertain"].includes(current.state)) {
            this.store.db
              .query("DELETE FROM reconcile_queue WHERE action_id=?")
              .run(action.id);
            return;
          }
          const state = await this.moderation.reconcile(current);
          this.store.db.transaction(() => {
            this.store.finishAction(
              action.id,
              state,
              [
                action.result,
                state === "uncertain"
                  ? "Результат неизвестен; нужна ручная проверка."
                  : "Результат подтверждён.",
              ]
                .filter(Boolean)
                .join("\n"),
            );
            if (action.reportId) {
              if (state === "succeeded")
                this.store.resolveReport(
                  action.reportId,
                  action.actorId,
                  "Скам-бан подтверждён после восстановления.",
                );
              if (state === "failed") this.store.releaseReport(action.reportId);
              this.store.enqueue("report-edit", { reportId: action.reportId });
            }
            this.notifications.actionLog(this.store.getAction(action.id)!);
            this.record("action_reconciled", { actionId: action.id, state });
            this.store.db
              .query("DELETE FROM reconcile_queue WHERE action_id=?")
              .run(action.id);
            if (
              state === "succeeded" &&
              !["ban", "kill", "kick", "scam"].includes(action.kind)
            )
              this.notifications.queueActionDm(
                this.store.getAction(action.id)!,
              );
          })();
          if (
            state === "succeeded" &&
            !["ban", "kill", "kick", "scam"].includes(action.kind)
          ) {
            const receipt = this.store.db
              .query(
                "SELECT 1 FROM audit WHERE event='dm_sent' AND json_extract(data,'$.actionId')=? LIMIT 1",
              )
              .get(action.id);
            if (!receipt)
              await this.notifications.actionDm(
                this.store.getAction(action.id)!,
              );
          }
        },
      );
    } catch (error) {
      const attempts = row.attempts + 1;
      this.store.db
        .query(
          "UPDATE reconcile_queue SET attempts=?,next_at=? WHERE action_id=?",
        )
        .run(
          attempts,
          Date.now() + Math.min(3_600_000, 5_000 * 2 ** Math.min(attempts, 10)),
          action.id,
        );
      if (attempts === 1 || (attempts & (attempts - 1)) === 0)
        this.logger.warn("Action reconciliation postponed", {
          actionId: action.id,
          attempts,
          code: errorCode(error),
        });
    }
  }

  private async expire(): Promise<void> {
    const now = Date.now();
    const due = this.store
      .listSanctions()
      .filter((sanction) => {
        if (sanction.expiresAt === null || sanction.expiresAt > now)
          return false;
        const retry = this.store.db
          .query<{ next_at: number }, [string]>(
            "SELECT next_at FROM expiry_retries WHERE action_id=?",
          )
          .get(sanction.actionId);
        return !retry || retry.next_at <= now;
      })
      .slice(0, 10);
    for (const sanction of due) {
      const retry = this.store.db
        .query<{ next_at: number; attempts: number }, [string]>(
          "SELECT * FROM expiry_retries WHERE action_id=?",
        )
        .get(sanction.actionId);
      if (retry && retry.next_at > Date.now()) continue;
      await this.control.locked(
        `${sanction.guildId}:${sanction.targetId}`,
        async () => {
          this.assertOperational();
          try {
            let recorded = false;
            const completed = (result: string) => {
              this.store.db
                .query("DELETE FROM expiry_retries WHERE action_id=?")
                .run(sanction.actionId);
              this.record("sanction_expired", { ...sanction, result });
              this.notifications.sanctionEnded(sanction, result);
              if (
                sanction.kind === "ban" &&
                /Блокировка (?:уже )?снята/i.test(result)
              )
                this.store.enqueue(
                  "dm",
                  {
                    targetId: sanction.targetId,
                    actionId: sanction.actionId,
                    template: "unban",
                    embeds: [
                      dmNotice(
                        `Бан снят. **[Вернуться на сервер](${this.config.inviteUrl})**.`,
                      ).toJSON(),
                    ],
                  },
                  `expiry-dm:${sanction.actionId}`,
                );
              recorded = true;
            };
            const result = await this.moderation.expire(sanction, completed);
            if (!recorded) this.store.db.transaction(() => completed(result))();
          } catch (error) {
            const attempts = (retry?.attempts ?? 0) + 1;
            this.store.db
              .query(
                "INSERT OR REPLACE INTO expiry_retries(action_id,next_at,attempts) VALUES(?,?,?)",
              )
              .run(
                sanction.actionId,
                Date.now() +
                  Math.min(3_600_000, 5_000 * 2 ** Math.min(attempts, 10)),
                attempts,
              );
            if (attempts === 1 || (attempts & (attempts - 1)) === 0)
              this.logger.warn("Sanction expiry postponed", {
                actionId: sanction.actionId,
                attempts,
                code: errorCode(error),
              });
            if (attempts === 1)
              this.notifications.log(
                logNotice(
                  `⚠️ Не удалось снять ${bold(sanction.kind === "ban" ? "бан" : "мьют")} с ${userMention(sanction.targetId)}; повторим позже.`,
                ),
              );
          }
        },
      );
    }
  }

  private async cleanConfirmations(): Promise<void> {
    this.store.expireActions();
    this.control.expireDrafts();
    for (const row of this.control.dueConfirmations()) {
      if (row.kind === "action") {
        const action = this.store.getAction(row.id);
        if (action?.state === "expired")
          this.notifications.actionLog(action, `expired:${row.id}`);
      }
      const action =
        row.kind === "action" ? this.store.getAction(row.id) : null;
      this.ephemeral.adopt(
        action?.interactionId ?? row.id,
        row.token,
        row.expires_at,
      );
      this.control.forgetConfirmation(row.id);
    }
  }

  private adoptConfirmations(): void {
    for (const row of this.control.confirmations()) {
      const action =
        row.kind === "action" ? this.store.getAction(row.id) : null;
      this.ephemeral.adopt(
        action?.interactionId ?? row.id,
        row.token,
        row.expires_at,
      );
    }
  }

  private async maintenance(): Promise<void> {
    if (this.maintenanceBusy || !this.client.isReady() || !this.operational())
      return;
    this.maintenanceBusy = true;
    try {
      await this.cleanConfirmations();
      await this.recover();
      await this.expire();
      const restores = this.store.db
        .query<{ user_id: string }, [number]>(
          "SELECT user_id FROM mute_restore_queue WHERE next_at<=? ORDER BY next_at LIMIT 5",
        )
        .all(Date.now());
      for (const restore of restores) await this.reapplyMute(restore.user_id);
    } finally {
      this.maintenanceBusy = false;
    }
  }

  private async register(): Promise<void> {
    if (
      this.registered ||
      this.registrationBusy ||
      !this.client.isReady() ||
      Date.now() < this.registrationAt
    )
      return;
    this.registrationBusy = true;
    try {
      await registerCommands(
        this.client.rest,
        this.client.application.id,
        this.config.guildId,
      );
      this.registered = true;
      this.record("commands_registered", {
        guildId: this.config.guildId,
        count: commandDefinitions().length,
      });
      if (!this.announced) {
        this.notifications.announceRestart(`startup:${this.owner}`);
        this.announced = true;
      }
    } catch (error) {
      this.registrationAttempts++;
      this.registrationAt =
        Date.now() +
        Math.min(60_000, 5_000 * 2 ** Math.min(this.registrationAttempts, 4));
      this.logger.warn("Command registration postponed", {
        code: errorCode(error),
        status: errorStatus(error),
        attempts: this.registrationAttempts,
      });
      if (this.registrationAttempts === 1 && permanent(error))
        this.notifications.announce(
          logNotice("⚠️ Не удалось зарегистрировать команды."),
        );
    } finally {
      this.registrationBusy = false;
    }
  }

  start(): Promise<void> {
    return (this.starting ??= this.run());
  }

  private async run(): Promise<void> {
    if (this.shutdown.signal.aborted)
      throw new Error("A stopped bot instance cannot restart");
    if (!this.control.lease(this.owner))
      throw new Error(
        "Another bot instance owns this database. Stop it or wait 20 seconds after an interrupted shutdown.",
      );
    this.active = true;
    this.adoptConfirmations();
    this.leaseTimer = setInterval(() => {
      if (!this.control.lease(this.owner)) {
        this.active = false;
        this.logger.error("Database lease lost");
        process.exitCode = 1;
        void this.stop();
      }
    }, 5_000);
    for (const sanction of this.store.listSanctions())
      if (sanction.kind === "mute") this.queueMuteRestore(sanction.targetId);
    for (const action of this.store.listInterruptedActions())
      if (!this.appeals.isAutomatic(action.id))
        this.queueReconciliation(action.id);
    for (const report of this.store.listOpenReports()) {
      if (!report.modMessageId)
        this.store.enqueue(
          "report",
          { reportId: report.id },
          `report:${report.id}`,
        );
      if (report.state === "processing") {
        const actionRow = this.store.db
          .query<{ id: string }, [string]>(
            "SELECT id FROM actions WHERE json_extract(payload,'$.reportId')=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
          )
          .get(report.id);
        const action = actionRow ? this.store.getAction(actionRow.id) : null;
        if (
          !action ||
          ["failed", "cancelled", "expired", "pending"].includes(action.state)
        ) {
          if (action?.state === "pending")
            this.store.finishAction(
              action.id,
              "failed",
              "Незавершённое действие репорта восстановлено без выполнения.",
            );
          this.store.releaseReport(report.id);
        } else if (action.state === "succeeded") {
          this.store.resolveReport(
            report.id,
            action.actorId,
            "Скам-аккаунт заблокирован.",
          );
          this.store.enqueue("report-edit", { reportId: report.id });
        }
      }
    }
    startKuma(
      this.config.kumaUrl,
      () =>
        this.client.isReady() &&
        this.registered &&
        !this.shutdown.signal.aborted,
      this.shutdown.signal,
    );
    this.timers.push(
      setInterval(() => {
        if (this.operational())
          this.track(this.ephemeral.tick(), "Ephemeral cleanup failed");
      }, 1_000),
      setInterval(() => {
        if (!this.operational()) return;
        this.track(this.notifications.tick(), "Notification worker failed");
        this.track(this.textLog.tick(), "Text log worker failed");
        this.track(this.appeals.tick(), "Appeal worker failed");
        this.track(this.register(), "Registration worker failed");
      }, 2_000),
    );
    this.timers.push(
      setInterval(
        () => this.track(this.maintenance(), "Maintenance failed"),
        5_000,
      ),
    );
    this.record("application_starting", {
      runtime: Bun.version,
      guildId: this.config.guildId,
    });
    let attempts = 0;
    while (!this.shutdown.signal.aborted) {
      try {
        await this.client.login(this.config.token);
        return;
      } catch (error) {
        if (this.shutdown.signal.aborted) return;
        if (
          permanent(error) ||
          /TokenInvalid|invalid token|used disallowed intents|Authentication failed|Used invalid intents/i.test(
            `${(error as Error).name} ${(error as Error).message} ${(error as { code?: unknown }).code}`,
          )
        )
          throw error;
        attempts++;
        const wait = Math.min(60_000, 5_000 * 2 ** Math.min(attempts - 1, 4));
        this.logger.warn("Discord login postponed", {
          attempts,
          retryInMs: wait,
          code: errorCode(error),
        });
        await this.client.destroy();
        try {
          await delay(wait, undefined, { signal: this.shutdown.signal });
        } catch {
          return;
        }
      }
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const completion = Promise.withResolvers<void>();
    this.stopping = completion.promise;
    void (async () => {
      this.shutdown.abort();
      this.active = false;
      for (const timer of this.timers) clearInterval(timer);
      try {
        // Keep the lease heartbeat until in-flight work has drained, even if REST is slow.
        try {
          await this.client.destroy();
        } catch (error) {
          this.logger.warn("Discord disconnect failed during shutdown", {
            code: errorCode(error),
          });
        }
        await Promise.allSettled([...this.tasks]);
        this.record("application_stopped", {});
      } finally {
        if (this.leaseTimer) clearInterval(this.leaseTimer);
        this.leaseTimer = null;
        this.control.releaseLease(this.owner);
      }
    })().then(completion.resolve, completion.reject);
    return this.stopping;
  }
}
