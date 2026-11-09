import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  type APIEmbed,
} from "discord.js";
import {
  scamAppealPhrase,
  type Action,
  type ActionKind,
  type Config,
  type MessageSnapshot,
  type Report,
} from "./types.ts";

type Tone = "neutral" | "success" | "warning" | "danger";
type Payload = {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
};

export const embedColor = 0xf1c41b;
const dmFooter = {
  text: "Модерация VRChatRU",
  icon_url: "https://i.imgur.com/72pQbbd.png",
};
const labels: Record<ActionKind, string> = {
  mute: "Мьют",
  kill: "Бан",
  kick: "Кик",
  ban: "Бан",
  unban: "Разбан",
  warn: "Предупреждение",
  purge: "Очистка",
  scam: "Бан за скам",
};
const states: Record<Action["state"], string> = {
  pending: "ожидает подтверждения",
  running: "выполняется",
  succeeded: "выполнено",
  failed: "ошибка",
  cancelled: "отменено",
  expired: "подтверждение истекло",
  uncertain: "результат не подтверждён",
};

export function clip(value: string, limit: number): string {
  return value.length > limit
    ? `${value.slice(0, Math.max(0, limit - 1))}…`
    : value;
}

function text(value: string, limit = 1000): string {
  return clip(escapeMarkdown(value).replaceAll("\u0000", ""), limit) || "—";
}

function person(id: string | null): string {
  return id ? userMention(id) : "пользователя";
}

export function bold(value: string): string {
  return value.startsWith("**") && value.endsWith("**")
    ? value
    : `**${value}**`;
}

export function userMention(id: string): string {
  return bold(`<@${id}>`);
}

function channelMention(id: string): string {
  return bold(`<#${id}>`);
}

function plural(value: number, one: string, few: string, many: string): string {
  if (!Number.isInteger(value)) return few;
  const last = Math.abs(value) % 10;
  const hundred = Math.abs(value) % 100;
  return hundred >= 11 && hundred <= 14
    ? many
    : last === 1
      ? one
      : last >= 2 && last <= 4
        ? few
        : many;
}

function duration(action: Action): string {
  if (action.durationDays === null) return bold("бессрочно");
  const days = new Intl.NumberFormat("ru", { maximumFractionDigits: 4 }).format(
    action.durationDays,
  );
  return `на ${bold(`${days} ${plural(action.durationDays, "день", "дня", "дней")}`)}`;
}

function reason(action: Pick<Action, "reason">, limit = 1000): string {
  if (!action.reason) return "";
  const value = action.reason.replace(
    /^Правило\s+(\d+)\s*[:·]\s*/u,
    "Правило $1. ",
  );
  return `\nПричина: ${bold(text(value, limit))}`;
}

function actionSentence(action: Action): string {
  const target = person(action.targetId);
  switch (action.kind) {
    case "mute":
      return `Заглушить ${target} ${duration(action)}.`;
    case "kill":
    case "ban":
      return `Забанить ${target} ${duration(action)}.`;
    case "kick":
      return `Кикнуть ${target}.`;
    case "unban":
      return `Разбанить ${target}.`;
    case "warn":
      return `Выдать предупреждение ${target}.`;
    case "purge": {
      const count = action.messageIds.length || action.count || 0;
      return `Удалить ${bold(`${count} ${plural(count, "сообщение", "сообщения", "сообщений")}`)} в ${channelMention(action.channelId)}.`;
    }
    case "scam":
      return `Забанить ${target} за скам.`;
  }
}

function appealDelay(config: Config): string {
  if (config.scamAppealHours === 336)
    return `Через ${bold("14 дней")} после блокировки`;
  if (config.scamAppealHours <= 0) return "После восстановления аккаунта";
  return `Через ${bold(`${new Intl.NumberFormat("ru").format(config.scamAppealHours)} ч.`)} после блокировки`;
}

function flattened(input: APIEmbed): string {
  const parts: string[] = [];
  if (input.title && !["Внимание!", "Вы уверенны?"].includes(input.title))
    parts.push(input.title);
  if (input.description) parts.push(input.description);
  for (const field of input.fields ?? [])
    parts.push(`${field.name}: ${field.value}`);
  return (
    clip(
      parts.join("\n").replace(/(<@!?(\d{17,20})>)\s*·\s*`\2`/g, "$1"),
      4096,
    ) || "—"
  );
}

export function dmEmbed(input: APIEmbed): APIEmbed {
  return {
    color: embedColor,
    title: "Внимание!",
    description: flattened(input),
    footer: { ...dmFooter },
  };
}

export function logEmbed(input: APIEmbed): APIEmbed {
  return { color: embedColor, description: flattened(input) };
}

export function dmNotice(description: string): EmbedBuilder {
  return new EmbedBuilder(dmEmbed({ description }));
}

export function logNotice(description: string): EmbedBuilder {
  return new EmbedBuilder(logEmbed({ description }));
}

export function notice(
  title: string,
  description: string,
  _tone: Tone = "neutral",
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(clip(title, 256))
    .setDescription(clip(description, 4096));
}

export function confirmation(action: Action, _config: Config): Payload {
  return {
    embeds: [
      notice("Вы уверенны?", `${actionSentence(action)}${reason(action)}`),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm:${action.id}`)
          .setLabel("Подтвердить")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`cancel:${action.id}`)
          .setLabel("Отмена")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

export function actionLog(action: Action): EmbedBuilder {
  const target = person(action.targetId);
  const actor = person(action.actorId);
  let description: string;
  if (action.state === "succeeded") {
    switch (action.kind) {
      case "mute":
        description = `${target} заглушен ${duration(action)}.`;
        break;
      case "kill":
      case "ban":
        description = `${target} забанен ${duration(action)}.`;
        break;
      case "kick":
        description = `${target} кикнут.`;
        break;
      case "unban":
        description = `${target} разбанен.`;
        break;
      case "warn":
        description = `${target} получил предупреждение.`;
        break;
      case "scam":
        description = `${target} забанен за скам.`;
        break;
      case "purge": {
        const count = action.messageIds.length || action.count || 0;
        const result =
          action.result && /^Удалено /u.test(action.result)
            ? text(action.result).replace(/\b\d+\b/g, (value) => bold(value))
            : `Удалено ${bold(`${count} ${plural(count, "сообщение", "сообщения", "сообщений")}`)}.`;
        description = `${channelMention(action.channelId)}\n${result}`;
        break;
      }
    }
  } else {
    const status =
      action.state === "failed"
        ? "❌ Ошибка"
        : action.state === "uncertain"
          ? "⚠️ Результат не подтверждён"
          : states[action.state];
    description = `${status[0]!.toUpperCase()}${status.slice(1)} · ${actor}: ${actionSentence(action)}`;
    if (["failed", "uncertain"].includes(action.state) && action.result)
      description += `\n${bold(text(action.result))}`;
  }
  return logNotice(`${description}${reason(action)}`);
}

export function actionDm(
  action: Action,
  _guildName: string,
  config: Config,
): EmbedBuilder {
  let description: string;
  switch (action.kind) {
    case "mute":
      description = `Вы были заглушены ${duration(action)}.`;
      break;
    case "kill":
    case "ban":
      description = `Вы были забанены ${duration(action)}.`;
      break;
    case "kick":
      description = "Вас кикнули.";
      break;
    case "unban":
      description = `Вы были разбанены.\n${bold(`[Вернуться на сервер](<${config.inviteUrl}>)`)}`;
      break;
    case "warn":
      description = "Вы получили предупреждение.";
      break;
    case "purge":
      description = "Сообщения удалены.";
      break;
    case "scam":
      return dmNotice(
        `Вы были забанены за скам.${reason(action)}\n\n${appealDelay(config)} напишите сюда:\n> ${bold(scamAppealPhrase)}\n\nМы автоматически снимем вам бан.`,
      );
  }
  return dmNotice(`${description}${reason(action)}`);
}

function messageLink(
  guildId: string,
  message: Pick<MessageSnapshot, "channelId" | "id">,
): string {
  return `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;
}

function attachmentLinks(attachments: string[], limit = 250): string {
  const links = attachments.slice(0, 3).flatMap((attachment, index) => {
    try {
      const url = new URL(attachment);
      return ["https:", "http:"].includes(url.protocol)
        ? [
            bold(
              `[Вложение ${index + 1}](<${url.href.replaceAll(">", "%3E")}>)`,
            ),
          ]
        : [];
    } catch {
      return [];
    }
  });
  let result = "";
  for (const link of links) {
    if (result.length + link.length + 3 > limit) break;
    result += `${result ? " · " : ""}${link}`;
  }
  return (
    result ||
    (attachments.length
      ? `${bold(String(attachments.length))} вложений в исходном сообщении.`
      : "")
  );
}

export function reportPayload(report: Report): Payload {
  const localTime = (stamp: number) =>
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(stamp);
  const stamp = (value: number) => bold(`[${localTime(value)}]`);
  const history = report.context.slice(-10).map((message) => {
    const body = text(
      message.content.replaceAll("\n", " ") ||
        (message.attachments.length ? "[вложение]" : "[без текста]"),
      60,
    );
    return `${stamp(message.createdAt)} [↗](${messageLink(report.guildId, message)}) ${body}`;
  });
  const groups: string[] = [];
  for (const line of history) {
    const last = groups.length - 1;
    if (last >= 0 && groups[last]!.length + line.length + 1 <= 1024)
      groups[last] += `\n${line}`;
    else groups.push(line);
  }
  const attachments = attachmentLinks(report.message.attachments, 180);
  const reportedMessage = `${stamp(report.message.createdAt)} ${text(report.message.content || "Текст отсутствует", 760)}\nID: ${bold(report.messageId)}${attachments ? `\n${attachments}` : ""}`;
  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle("[Ссылка на сообщение]")
    .setURL(messageLink(report.guildId, report.message))
    .setDescription(
      `На сообщение в ${channelMention(report.channelId)} поступила жалоба.\nОтправлено: ${bold(`<t:${Math.floor(report.createdAt / 1000)}:R>`)}`,
    )
    .addFields({
      name: "Пользователь:",
      value: `${person(report.targetId)}\nИмя: ${bold(text(report.message.authorName, 100))}\nID: ${bold(report.targetId)}`,
    });
  for (const [index, group] of (groups.length
    ? groups
    : ["Доступных сообщений нет."]
  ).entries()) {
    embed.addFields({
      name: index === 0 ? "Последние сообщения пользователя:" : "\u200b",
      value: group,
    });
  }
  embed.addFields(
    { name: "Сообщение:", value: reportedMessage },
    {
      name: "Кто пожаловался:",
      value: `${person(report.reporterId)}${report.reporterName ? ` (${bold(text(report.reporterName, 80))})` : ""}`,
    },
    {
      name: "Причина:",
      value: report.reason ? bold(text(report.reason, 800)) : "Не указана.",
    },
  );
  if (report.contextWarning)
    embed.addFields({
      name: "История может быть неполной:",
      value: bold(text(report.contextWarning, 300)),
    });
  if (report.state === "processing")
    embed.addFields({ name: "Статус:", value: "Проверяется." });
  if (report.targetAvatarUrl && /^https?:\/\//.test(report.targetAvatarUrl))
    embed.setThumbnail(report.targetAvatarUrl);
  const localDate = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(report.createdAt);
  embed.setFooter({ text: `Жалоба • ${localDate}` });
  return {
    embeds: [embed],
    components:
      report.state === "resolved"
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`report-status:${report.id}`)
                .setLabel(
                  /скам/i.test(report.resolution ?? "")
                    ? "Забанен за скам"
                    : "Решено",
                )
                .setStyle(
                  /скам/i.test(report.resolution ?? "")
                    ? ButtonStyle.Success
                    : ButtonStyle.Secondary,
                )
                .setDisabled(true),
            ),
          ]
        : [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`report-scam:${report.id}`)
                .setLabel("Скаммер")
                .setStyle(ButtonStyle.Danger)
                .setDisabled(report.state === "processing"),
              new ButtonBuilder()
                .setCustomId(`report-resolve:${report.id}`)
                .setLabel("Решено")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(false),
            ),
          ],
  };
}
export function modlogs(
  actions: Action[],
  targetId: string,
  page: number,
): Payload {
  const entries = actions.slice(0, 10).map((action) => {
    const stamp = `<t:${Math.floor((action.completedAt ?? action.createdAt) / 1000)}:d>`;
    const term = ["mute", "ban", "kill"].includes(action.kind)
      ? ` ${duration(action)}`
      : "";
    const detail =
      ["failed", "uncertain"].includes(action.state) && action.result
        ? `\n${bold(text(action.result, 100))}`
        : "";
    return `${bold(stamp)} · ${bold(labels[action.kind])}${term} · ${bold(states[action.state])} · ${person(action.actorId)}${reason(action, 150)}${detail}`;
  });
  const description = `${person(targetId)} · страница ${bold(String(page + 1))}\n\n${entries.length ? entries.join("\n\n") : "Записей нет."}`;
  return {
    embeds: [logNotice(description)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`logs:${targetId}:${Math.max(0, page - 1)}`)
          .setLabel("Назад")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page <= 0),
        new ButtonBuilder()
          .setCustomId(`logs:${targetId}:${page + 1}`)
          .setLabel("Далее")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(actions.length < 10),
      ),
    ],
  };
}
