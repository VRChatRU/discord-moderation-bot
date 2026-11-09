import {
  AuditLogEvent,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
} from "discord.js";
import { moderationPlugins } from "../plugins/index.ts";
import type { Store } from "./store.ts";
import type { Action, ActionKind, Config, Logger, Sanction } from "./types.ts";

export class UserFacingError extends Error {}

export function validSnowflake(value: string): boolean {
  return (
    /^[1-9]\d{16,19}$/.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  );
}

export function actionStartedAt(store: Store, action: Action): number {
  const attempt = store.db
    .query<{ created_at: number }, [string]>(
      "SELECT created_at FROM audit WHERE event='moderation.attempt' AND json_extract(data,'$.actionId')=? ORDER BY id LIMIT 1",
    )
    .get(action.id);
  // An attempt is written durably before the Discord mutation. Legacy/recovered cases
  // without an attempt retain their original date rather than restarting their deadline.
  return attempt?.created_at ?? action.createdAt;
}

export interface ModerationContext {
  client: Client;
  store: Store;
  config: Config;
  logger: Logger;
  guild: Guild;
  actor: GuildMember;
  bot: GuildMember;
  target: GuildMember | null;
  auditReason: string;
  assertActive(): void;
}

export interface ModerationPlugin {
  name: ActionKind;
  execute(context: ModerationContext, action: Action): Promise<string>;
}

const permissions: Record<ActionKind, bigint> = {
  mute: PermissionFlagsBits.ManageRoles,
  kill: PermissionFlagsBits.BanMembers,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
  unban: PermissionFlagsBits.BanMembers,
  warn: PermissionFlagsBits.ModerateMembers,
  purge: PermissionFlagsBits.ManageMessages,
  scam: PermissionFlagsBits.BanMembers,
};

export function permissionFor(kind: ActionKind): bigint {
  return permissions[kind];
}

export function isModerator(
  member: GuildMember,
  config: Config,
  permission: bigint,
): boolean {
  return (
    member.permissions.has(permission) ||
    config.moderatorRoleIds.some((id) => member.roles.cache.has(id))
  );
}

export function discordCode(error: unknown): number | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = Number(error.code);
    if (Number.isFinite(code)) return code;
  }
  return null;
}

export function isPermanentError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    "uncertain" in error &&
    error.uncertain === true
  )
    return false;
  if (error instanceof Error && error.name === "PurgePartialError") return true;
  if (error instanceof UserFacingError) return true;
  if (error && typeof error === "object" && "status" in error) {
    const status = Number(error.status);
    return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
  }
  const code = discordCode(error);
  return (
    code !== null &&
    (code === 10007 ||
      code === 10013 ||
      code === 10026 ||
      code === 50001 ||
      code === 50013)
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "PurgePartialError")
    return error.message;
  if (error instanceof UserFacingError) return error.message;
  switch (discordCode(error)) {
    case 10003:
      return "Канал больше не существует.";
    case 10007:
      return "Пользователь больше не состоит на сервере.";
    case 10008:
      return "Сообщение уже удалено.";
    case 10013:
      return "Пользователь с таким ID не найден.";
    case 10026:
      return "Пользователь не заблокирован.";
    case 50001:
      return "У бота нет доступа к этому каналу или пользователю.";
    case 50013:
      return "У бота недостаточно прав или его роль находится слишком низко.";
    default:
      return "Discord недоступен. Проверяем результат.";
  }
}

export function caseMarker(actionId: string): string {
  return `[case:${actionId}]`;
}

export function auditReason(action: Action): string {
  const suffix = ` | moderator:${action.actorId} ${caseMarker(action.id)}`;
  return `${action.reason?.slice(0, Math.max(0, 512 - suffix.length)) || action.kind}${suffix}`;
}

export async function fetchGuild(
  client: Client,
  guildId: string,
): Promise<Guild> {
  const guild = await client.guilds.fetch({ guild: guildId, force: true });
  await guild.roles.fetch();
  return guild;
}

export async function fetchMember(
  guild: Guild,
  userId: string,
): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch({ user: userId, force: true });
  } catch (error) {
    if (discordCode(error) === 10007) return null;
    throw error;
  }
}

export async function fetchBan(guild: Guild, userId: string) {
  try {
    return await guild.bans.fetch({ user: userId, force: true });
  } catch (error) {
    if (discordCode(error) === 10026) return null;
    throw error;
  }
}

export function sanctionFor(
  action: Action,
  config: Config,
  now = Date.now(),
): Sanction {
  if (
    !action.targetId ||
    !["mute", "ban", "kill", "scam"].includes(action.kind)
  ) {
    throw new Error("Action does not create a sanction");
  }
  return {
    guildId: action.guildId,
    targetId: action.targetId,
    kind: action.kind === "mute" ? "mute" : "ban",
    actionId: action.id,
    expiresAt:
      action.durationDays === null
        ? null
        : now + Math.round(action.durationDays * 86_400_000),
    roleId: action.kind === "mute" ? config.muteRoleId : null,
  };
}

export class Moderation {
  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly beforeMutation: () => void = () => {},
  ) {
    store.db.exec(
      "CREATE INDEX IF NOT EXISTS audit_action ON audit(event,json_extract(data,'$.actionId'));",
    );
  }

  private async context(action: Action): Promise<ModerationContext> {
    if (action.guildId !== this.config.guildId)
      throw new UserFacingError(
        "Команда доступна только на настроенном сервере.",
      );
    if (
      action.kind !== "purge" &&
      (!action.targetId || !validSnowflake(action.targetId))
    )
      throw new UserFacingError("Укажите корректный ID пользователя.");
    const guild = await fetchGuild(this.client, action.guildId);
    const [actor, bot, target] = await Promise.all([
      fetchMember(guild, action.actorId),
      guild.members.fetchMe({ force: true }),
      action.targetId
        ? fetchMember(guild, action.targetId)
        : Promise.resolve(null),
    ]);
    if (!actor)
      throw new UserFacingError("Модератор больше не состоит на сервере.");
    if (
      !target &&
      action.targetId &&
      ["ban", "kill", "scam", "warn"].includes(action.kind)
    ) {
      // Guild absence is distinct from an invalid Discord account. In particular,
      // a warning without a DM must not create history for a nonexistent ID.
      await this.client.users.fetch(action.targetId);
    }
    return {
      client: this.client,
      store: this.store,
      config: this.config,
      logger: this.logger,
      guild,
      actor,
      bot,
      target,
      auditReason: auditReason(action),
      assertActive: this.beforeMutation,
    };
  }

  private async validateContext(
    action: Action,
    context: ModerationContext,
  ): Promise<void> {
    const { guild, actor, bot, target } = context;
    if (!isModerator(actor, this.config, permissionFor(action.kind))) {
      throw new UserFacingError("У вас больше нет прав для этого действия.");
    }
    if (action.reason !== null && action.reason.length > 1000)
      throw new UserFacingError(
        "Причина должна быть не длиннее 1000 символов.",
      );
    if (
      action.durationDays !== null &&
      (!Number.isFinite(action.durationDays) ||
        action.durationDays <= 0 ||
        action.durationDays > 36500 ||
        !["mute", "ban", "kill"].includes(action.kind))
    ) {
      throw new UserFacingError(
        "Срок должен быть положительным числом дней, не больше 36500.",
      );
    }
    if (action.kind === "purge") {
      const channel = await guild.channels.fetch(action.channelId, {
        force: true,
      });
      if (!channel?.isTextBased() || !("messages" in channel))
        throw new UserFacingError("В этом канале нельзя удалять сообщения.");
      if (!actor.permissionsIn(channel).has(PermissionFlagsBits.ViewChannel))
        throw new UserFacingError("У вас больше нет доступа к этому каналу.");
      if (
        !actor.permissionsIn(channel).has(PermissionFlagsBits.ManageMessages) &&
        !this.config.moderatorRoleIds.some((id) => actor.roles.cache.has(id))
      ) {
        throw new UserFacingError(
          "У вас нет права удалять сообщения в этом канале.",
        );
      }
      if (
        !bot
          .permissionsIn(channel)
          .has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
          ])
      ) {
        throw new UserFacingError(
          "Боту нужны права просмотра канала, чтения истории и удаления сообщений.",
        );
      }
      if (
        !Number.isInteger(action.count) ||
        !action.count ||
        action.count < 1 ||
        action.count > 100 ||
        action.messageIds.length > action.count ||
        action.messageIds.length < 1 ||
        new Set(action.messageIds).size !== action.messageIds.length ||
        action.messageIds.some((id) => !validSnowflake(id))
      ) {
        throw new UserFacingError(
          "Выберите от 1 до 100 существующих сообщений.",
        );
      }
      return;
    }
    if (!action.targetId || !validSnowflake(action.targetId))
      throw new UserFacingError("Укажите корректный ID пользователя.");
    if (action.targetId === actor.id)
      throw new UserFacingError("Нельзя применить это действие к себе.");
    if (action.targetId === bot.id)
      throw new UserFacingError(
        "Нельзя применить это действие к боту модерации.",
      );
    if (action.targetId === guild.ownerId)
      throw new UserFacingError(
        "Нельзя применить это действие к владельцу сервера.",
      );
    if (
      target &&
      actor.id !== guild.ownerId &&
      actor.roles.highest.comparePositionTo(target.roles.highest) <= 0
    ) {
      throw new UserFacingError(
        "Роль пользователя должна находиться ниже вашей роли.",
      );
    }
    if (action.kind !== "warn" && action.kind !== "unban") {
      if (!bot.permissions.has(permissionFor(action.kind)))
        throw new UserFacingError(
          "У бота недостаточно прав для этого действия.",
        );
      if (
        target &&
        bot.roles.highest.comparePositionTo(target.roles.highest) <= 0
      )
        throw new UserFacingError(
          "Роль пользователя должна находиться ниже роли бота.",
        );
    }
    if (["mute", "kick"].includes(action.kind) && !target)
      throw new UserFacingError("Пользователь не состоит на сервере.");
    if (action.kind === "mute") {
      const role = await guild.roles.fetch(this.config.muteRoleId, {
        force: true,
      });
      if (!role || role.id === guild.id || role.managed)
        throw new UserFacingError(
          "Роль mute не найдена или ею нельзя управлять.",
        );
      if (role.permissions.has(PermissionFlagsBits.Administrator))
        throw new UserFacingError(
          "Роль mute не должна выдавать право «Администратор».",
        );
      if (bot.roles.highest.comparePositionTo(role) <= 0)
        throw new UserFacingError(
          "Роль mute должна находиться ниже роли бота.",
        );
      if (
        actor.id !== guild.ownerId &&
        actor.roles.highest.comparePositionTo(role) <= 0
      )
        throw new UserFacingError(
          "Роль mute должна находиться ниже вашей роли.",
        );
      if (target!.permissions.has(PermissionFlagsBits.Administrator))
        throw new UserFacingError("Роль mute не ограничит администратора.");
      if (target!.roles.cache.has(role.id))
        throw new UserFacingError("У пользователя уже есть роль mute.");
    }
    if (
      ["ban", "kill", "scam"].includes(action.kind) &&
      (await fetchBan(guild, action.targetId))
    ) {
      throw new UserFacingError(
        "Пользователь уже заблокирован. Существующий бан не изменён.",
      );
    }
    if (action.kind === "unban") {
      if (!bot.permissions.has(PermissionFlagsBits.BanMembers))
        throw new UserFacingError("У бота нет права снимать блокировки.");
      if (!(await fetchBan(guild, action.targetId)))
        throw new UserFacingError("Пользователь не заблокирован.");
    }
  }

  async validate(action: Action): Promise<void> {
    await this.validateContext(action, await this.context(action));
  }

  async execute(action: Action): Promise<string> {
    if (this.store.getAction(action.id)?.state !== "running")
      throw new UserFacingError(
        "Это действие не подтверждено или уже завершено.",
      );
    const context = await this.context(action);
    await this.validateContext(action, context);
    this.beforeMutation();
    this.store.audit("moderation.attempt", {
      actionId: action.id,
      kind: action.kind,
      actorId: action.actorId,
      targetId: action.targetId,
      roleId: action.kind === "mute" ? this.config.muteRoleId : null,
    });
    const result = await moderationPlugins[action.kind].execute(
      context,
      action,
    );
    this.store.audit("moderation.applied", { actionId: action.id, result });
    return result;
  }

  async expire(
    sanction: Sanction,
    onCompleted?: (result: string) => void,
  ): Promise<string> {
    const complete = (result: string): string => {
      this.store.db.transaction(() => {
        this.store.removeSanction(
          sanction.guildId,
          sanction.targetId,
          sanction.kind,
          sanction.actionId,
        );
        onCompleted?.(result);
      })();
      return result;
    };
    const current = this.store.getSanction(
      sanction.guildId,
      sanction.targetId,
      sanction.kind,
    );
    if (!current || current.actionId !== sanction.actionId)
      return "Срок уже изменён другим действием.";
    if (current.expiresAt === null || current.expiresAt > Date.now())
      return "Срок наказания ещё не истёк.";
    const guild = await this.client.guilds.fetch(sanction.guildId);
    if (sanction.kind === "mute") {
      const member = await fetchMember(guild, sanction.targetId);
      if (
        member &&
        sanction.roleId &&
        member.roles.cache.has(sanction.roleId)
      ) {
        this.beforeMutation();
        await member.roles.remove(
          sanction.roleId,
          `Mute expired ${caseMarker(sanction.actionId)}`,
        );
      }
      return complete(
        member
          ? "Срок mute истёк. Роль снята."
          : "Срок mute истёк. Пользователь уже покинул сервер.",
      );
    }
    const ban = await fetchBan(guild, sanction.targetId);
    if (!ban) {
      return complete("Срок бана истёк. Блокировка уже снята.");
    }
    if (!ban.reason?.includes(caseMarker(sanction.actionId))) {
      return complete(
        "Автоматический разбан отменён: блокировка была изменена другим действием.",
      );
    }
    this.beforeMutation();
    await guild.members.unban(
      sanction.targetId,
      `Ban expired ${caseMarker(sanction.actionId)}`,
    );
    return complete("Срок бана истёк. Блокировка снята.");
  }

  async reconcile(
    action: Action,
  ): Promise<"succeeded" | "failed" | "uncertain"> {
    const applied = this.store.db
      .query(
        "SELECT 1 FROM audit WHERE event='moderation.applied' AND json_extract(data,'$.actionId')=? LIMIT 1",
      )
      .get(action.id);
    // This receipt is persisted after the mutation returns. Later manual changes
    // must not turn a completed action into a failed one or recreate a sanction.
    if (applied) return "succeeded";
    const attempted = this.store.db
      .query(
        "SELECT 1 FROM audit WHERE event='moderation.attempt' AND json_extract(data,'$.actionId')=? LIMIT 1",
      )
      .get(action.id);
    if (["kick", "warn", "purge"].includes(action.kind) && !attempted)
      return "failed";
    const guild = await this.client.guilds.fetch(action.guildId);
    if (!action.targetId) return "uncertain";
    if (["ban", "kill", "scam"].includes(action.kind)) {
      const ban = await fetchBan(guild, action.targetId);
      if (!ban) return "failed";
      if (!ban.reason?.includes(caseMarker(action.id))) return "uncertain";
      // Preserve the original deadline: recovery must never extend a temporary sanction.
      const existing = this.store.getSanction(
        action.guildId,
        action.targetId,
        "ban",
      );
      if (existing && existing.actionId !== action.id) return "uncertain";
      if (!existing)
        this.store.setSanction(
          sanctionFor(action, this.config, actionStartedAt(this.store, action)),
        );
      return "succeeded";
    }
    if (action.kind === "unban") {
      if (await fetchBan(guild, action.targetId)) return "uncertain";
      this.store.removeSanction(action.guildId, action.targetId, "ban");
      return "succeeded";
    }
    if (action.kind === "mute") {
      const existing = this.store.getSanction(
        action.guildId,
        action.targetId,
        "mute",
      );
      if (existing && existing.actionId !== action.id) return "uncertain";
      const attempt = this.store.db
        .query<{ roleId: string | null }, [string]>(
          "SELECT json_extract(data,'$.roleId') AS roleId FROM audit WHERE event='moderation.attempt' AND json_extract(data,'$.actionId')=? ORDER BY id LIMIT 1",
        )
        .get(action.id);
      const roleId =
        existing?.roleId ??
        (attempt?.roleId && validSnowflake(attempt.roleId)
          ? attempt.roleId
          : this.config.muteRoleId);
      const member = await fetchMember(guild, action.targetId);
      if (!member?.roles.cache.has(roleId)) {
        // Sanctions are written only after Discord confirms the role assignment.
        // Keep an owned mute when the member leaves before action completion.
        return existing?.actionId === action.id ? "succeeded" : "failed";
      }
      if (existing?.actionId === action.id) return "succeeded";
      const me = await guild.members.fetchMe({ force: true });
      if (!me.permissions.has(PermissionFlagsBits.ViewAuditLog))
        return "uncertain";
      const entries = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberRoleUpdate,
        limit: 25,
      });
      const evidence = entries.entries.some(
        (entry) =>
          entry.targetId === action.targetId &&
          entry.reason?.includes(caseMarker(action.id)) &&
          entry.changes.some(
            (change) =>
              change.key === "$add" &&
              Array.isArray(change.new) &&
              change.new.some((role: { id?: string }) => role.id === roleId),
          ),
      );
      if (!evidence) return "uncertain";
      this.store.setSanction({
        ...sanctionFor(
          action,
          this.config,
          actionStartedAt(this.store, action),
        ),
        roleId,
      });
      return "succeeded";
    }
    return "uncertain";
  }
}
