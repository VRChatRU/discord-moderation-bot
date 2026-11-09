import {
  ButtonStyle,
  REST,
  Routes,
  type APIChannel,
  type RESTPostAPIChannelMessageJSONBody,
} from "discord.js";
import { resolve } from "node:path";
import {
  actionKinds,
  type Action,
  type Config,
  type MessageSnapshot,
  type Report,
} from "./types.ts";
import {
  actionDm,
  actionLog,
  confirmation,
  dmNotice,
  bold,
  userMention,
  logNotice,
  modlogs,
  reportPayload,
} from "./ui.ts";
import { createLogger } from "./logger.ts";
import { Store } from "./store.ts";

type SamplePayload = {
  embeds: Array<{ toJSON(): object }>;
  components?: Array<{ toJSON(): object }>;
};

export interface Preview {
  label: string;
  payload: RESTPostAPIChannelMessageJSONBody;
  files?: Array<{ name: string; content: string }>;
}

const ids = {
  guild: "100000000000000001",
  muteRole: "100000000000000002",
  modLog: "100000000000000003",
  botChannel: "100000000000000004",
  moderator: "100000000000000011",
  target: "100000000000000012",
  channel: "100000000000000013",
  reporter: "100000000000000014",
  otherChannel: "100000000000000015",
  modRole: "100000000000000016",
};

function readable(value: string): string {
  return value
    .replaceAll(
      `<@${ids.moderator}>`,
      `[Moderator1337](https://discord.com/users/${ids.moderator})`,
    )
    .replaceAll(
      `<@${ids.target}>`,
      `[User42](https://discord.com/users/${ids.target})`,
    )
    .replaceAll(
      `<@${ids.reporter}>`,
      `[User8](https://discord.com/users/${ids.reporter})`,
    )
    .replaceAll(`<@&${ids.muteRole}>`, "роль «Мьют»")
    .replaceAll(`<@&${ids.modRole}>`, "@Модерация")
    .replaceAll(`<#${ids.channel}>`, "#общий")
    .replaceAll(`<#${ids.otherChannel}>`, "#обсуждения")
    .replaceAll(`<#${ids.modLog}>`, "#модерация")
    .replaceAll(`<#${ids.botChannel}>`, "#боты");
}

export function previewFixtures(): Preview[] {
  const config: Config = {
    token: "preview",
    guildId: ids.guild,
    muteRoleId: ids.muteRole,
    modLogChannelId: ids.modLog,
    textLogChannelId: "760706717188489226",
    botChannelId: ids.botChannel,
    inviteUrl: "https://vrcru.org/discord",
    moderatorRoleIds: [ids.modRole],
    kumaUrl: "https://example.com/api/push/preview",
    rules: new Map([[3, "Конь педальный"]]),
    previewThreadId: "1568864293712171018",
    scamAppealHours: 336,
    reportContext: "guild",
    killHistory: false,
  };
  const now = Date.now();
  const base: Action = {
    id: "preview-001",
    interactionId: "100000000000000010",
    guildId: config.guildId,
    actorId: ids.moderator,
    targetId: ids.target,
    channelId: ids.channel,
    kind: "mute",
    reason: "Правило 3. Конь педальный",
    durationDays: 48,
    count: null,
    reportId: null,
    createdAt: now,
    confirmUntil: now + 30_000,
    messageIds: [],
    state: "pending",
    result: null,
    completedAt: null,
  };
  const fixtures: Preview[] = [];
  const add = (
    label: string,
    sample: SamplePayload,
    files?: Preview["files"],
    content?: string,
  ): void => {
    const payload: RESTPostAPIChannelMessageJSONBody = {
      embeds: sample.embeds.map((embed) =>
        embed.toJSON(),
      ) as RESTPostAPIChannelMessageJSONBody["embeds"],
      components: sample.components?.map((row) => {
        const json = row.toJSON() as {
          components?: Array<Record<string, unknown>>;
        };
        // Every interactive preview is inert, including persisted custom IDs.
        for (const component of json.components ?? [])
          component.disabled = true;
        return json;
      }) as RESTPostAPIChannelMessageJSONBody["components"],
      allowed_mentions: { parse: [] },
      ...(content ? { content } : {}),
      ...(files?.length
        ? {
            attachments: files.map((file, index) => ({
              id: index,
              filename: file.name,
            })),
          }
        : {}),
    };
    fixtures.push({
      label,
      payload: JSON.parse(
        JSON.stringify(payload, (_key, value: unknown) =>
          typeof value === "string" ? readable(value) : value,
        ),
      ),
      ...(files?.length ? { files } : {}),
    });
  };

  for (const [index, kind] of actionKinds.entries()) {
    const action: Action = {
      ...base,
      kind,
      id: `preview-${String(index + 1).padStart(3, "0")}`,
      durationDays: ["mute", "kill", "ban"].includes(kind) ? 48 : null,
      reason: ["scam", "unban", "purge"].includes(kind) ? null : base.reason,
      targetId: kind === "purge" ? null : base.targetId,
      count: kind === "purge" ? 25 : null,
      messageIds:
        kind === "purge"
          ? Array.from({ length: 25 }, (_, offset) =>
              String(100000000000000100n + BigInt(offset)),
            )
          : [],
    };
    add(`/${kind} · подтверждение`, confirmation(action, config));
    if (kind !== "purge") {
      add(`/${kind} · личное сообщение`, {
        embeds: [actionDm(action, "VRChatRU", config)],
      });
    }
    add(`/${kind} · mod-log`, {
      embeds: [
        actionLog({
          ...action,
          state: "succeeded",
          completedAt: now,
          result: kind === "purge" ? "Удалено 25 сообщений." : null,
        }),
      ],
    });
  }

  add(
    "/mute · без срока и причины",
    confirmation(
      {
        ...base,
        durationDays: null,
        reason: null,
      },
      config,
    ),
  );
  add("Отмена", { embeds: [logNotice("Отменено.")] });
  add("Выполнение", { embeds: [logNotice("Выполняется…")] });
  add("Подтверждение истекло", {
    embeds: [logNotice("Подтверждение истекло.")],
  });
  add("Не хватает прав", {
    embeds: [
      logNotice(
        "У бота недостаточно прав или его роль находится слишком низко.",
      ),
    ],
  });
  add("Результат проверяется", {
    embeds: [logNotice("Discord недоступен. Проверяем результат.")],
  });

  const snapshots: MessageSnapshot[] = Array.from(
    { length: 10 },
    (_, index) => ({
      id: String(100000000000000030n + BigInt(index)),
      channelId: index % 2 === 0 ? ids.channel : ids.otherChannel,
      authorId: ids.target,
      authorName: "User42",
      content: [
        "Всем привет!",
        "Кто сегодня идёт на встречу?",
        "Я буду ближе к вечеру.",
        "Спасибо за приглашение.",
        "В каком мире собираемся?",
        "Вижу анонс, теперь понятно.",
        "Проверю настройки звука.",
        "Скоро вернусь.",
        "Получилось подключиться.",
        "Посмотрите, что мне прислали: https://example.com/gift",
      ][index]!,
      attachments: [],
      createdAt: now - (10 - index) * 60_000,
    }),
  );
  const report: Report = {
    id: "preview-report",
    interactionId: "100000000000000050",
    guildId: config.guildId,
    channelId: snapshots[9]!.channelId,
    messageId: snapshots[9]!.id,
    targetId: ids.target,
    reporterId: ids.reporter,
    reason: "Подозрительная ссылка, возможно аккаунт взломан.",
    targetAvatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
    reporterName: "User8",
    message: snapshots[9]!,
    context: snapshots,
    createdAt: now,
    state: "open",
    modMessageId: null,
    resolvedBy: null,
    resolution: null,
  };
  for (const [label, value] of [
    ["Репорт · новый", report],
    ["Репорт · обрабатывается", { ...report, state: "processing" as const }],
    [
      "Репорт · решено",
      {
        ...report,
        state: "resolved" as const,
        resolvedBy: ids.moderator,
        resolution: "Проверено модератором.",
      },
    ],
    [
      "Репорт · забанен за скам",
      {
        ...report,
        state: "resolved" as const,
        resolvedBy: ids.moderator,
        resolution: "Скам-аккаунт заблокирован.",
      },
    ],
  ] as const) {
    add(label, reportPayload(value), undefined, `**<@&${ids.modRole}>**`);
  }
  add("Репорт отправлен", {
    embeds: [logNotice("Жалоба отправлена.")],
  });
  add(
    "/modlogs",
    modlogs(
      actionKinds
        .filter((kind) => kind !== "purge")
        .slice(0, 4)
        .map((kind, index) => ({
          ...base,
          kind,
          id: `preview-history-${index + 1}`,
          state: "succeeded",
          durationDays: ["mute", "kill", "ban"].includes(kind) ? 48 : null,
          completedAt: now - index * 86_400_000,
        })),
      ids.target,
      0,
    ),
  );
  add("ЛС закрыты · mod-log", {
    embeds: [
      logNotice(`⚠️ Не удалось отправить ЛС ${userMention(ids.target)}.`),
    ],
  });
  const appealMessages = [
    [
      "Обращение · доступ восстановлен",
      `Бан снят. ${bold(`[Вернуться на сервер](${config.inviteUrl})`)}`,
    ],
  ];
  for (const [label, description] of appealMessages) {
    add(label!, { embeds: [dmNotice(description!)] });
  }
  return fixtures;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rich(value: string): string {
  return htmlEscape(value)
    .replace(
      /&lt;t:(\d+):[a-zA-Z]&gt;/g,
      (_match, timestamp) =>
        `<span class="timestamp">${new Date(Number(timestamp) * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}</span>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /\[([^\]]+)\]\(&lt;(https?:\/\/[^)\s]+)&gt;\)/g,
      '<a href="$2" rel="noreferrer">$1</a>',
    )
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" rel="noreferrer">$1</a>',
    )
    .replaceAll("\n", "<br>");
}

function footerIcon(url: string | undefined, size = 20): string {
  if (!url) return "";
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) return "";
  } catch {
    return "";
  }
  return `<img src="${htmlEscape(url)}" alt="" width="${size}" height="${size}">`;
}

export function previewHtml(fixtures: Preview[]): string {
  const panels = fixtures
    .map(({ label, payload, files }, index) => {
      const embeds = (payload.embeds ?? [])
        .map((embed) => {
          const fields = (embed.fields ?? [])
            .map(
              (field) =>
                `<div class="field${field.inline ? " inline" : ""}"><h4>${htmlEscape(field.name)}</h4>${rich(field.value)}</div>`,
            )
            .join("");
          const titleUrl =
            embed.url && /^https?:\/\//i.test(embed.url) ? embed.url : null;
          const title = embed.title
            ? `<h3>${titleUrl ? `<a href="${htmlEscape(titleUrl)}" rel="noreferrer">${htmlEscape(embed.title)}</a>` : htmlEscape(embed.title)}</h3>`
            : "";
          const thumbnail = embed.thumbnail?.url
            ? `<aside class="thumbnail">${footerIcon(embed.thumbnail.url, 88)}</aside>`
            : "";
          const timestamp = embed.timestamp
            ? ` • ${new Date(embed.timestamp).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`
            : "";
          return `<div class="embed" style="border-color:#${(embed.color ?? 15844379).toString(16).padStart(6, "0")}">${thumbnail}${title}${embed.description ? `<div>${rich(embed.description)}</div>` : ""}${fields ? `<div class="fields">${fields}</div>` : ""}${embed.footer ? `<footer>${footerIcon(embed.footer.icon_url)}<span>${htmlEscape(embed.footer.text + timestamp)}</span></footer>` : ""}</div>`;
        })
        .join("");
      const buttons = (payload.components ?? [])
        .flatMap<{ label?: string; style?: number }>((row) =>
          "components" in row
            ? (row.components as Array<{ label?: string; style?: number }>)
            : [],
        )
        .map(
          (button) =>
            `<button class="${button.style === ButtonStyle.Danger ? "danger" : "secondary"}" disabled>${htmlEscape(button.label ?? "")}</button>`,
        )
        .join("");
      const attachments = (files ?? [])
        .map(
          (file) =>
            `<details class="attachment"><summary>${htmlEscape(file.name)}<small>Текст сообщения и последние 10 сообщений</small></summary><pre>${htmlEscape(file.content)}</pre></details>`,
        )
        .join("");
      return `<article id="sample-${index + 1}"><h2>${htmlEscape(label)}</h2><div class="sender"><span class="avatar">V</span><span>VRChatRU <b>APP</b></span></div>${payload.content ? `<div class="body-content">${rich(payload.content)}</div>` : ""}${embeds}${attachments}${buttons ? `<div class="buttons">${buttons}</div>` : ""}</article>`;
    })
    .join("\n");
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Модерация VRChatRU</title><style>
    :root{color-scheme:dark;font-family:system-ui,sans-serif;color:#dbdee1;background:#1e1f22;font-size:14px}*{box-sizing:border-box}body{max-width:900px;margin:auto;padding:32px 24px}header{margin-bottom:28px}h1{font-size:22px;margin:0 0 6px}header p{color:#949ba4;margin:0}article{margin:0 0 20px;padding:20px;background:#313338;border-radius:8px}h2{font-size:12px;font-weight:500;color:#949ba4;margin:0 0 16px}.sender{display:flex;gap:10px;align-items:center;margin-bottom:8px;font-weight:600}.avatar{display:grid;place-items:center;background:#5865f2;color:white;width:32px;height:32px;border-radius:50%}.sender b{background:#5865f2;font-size:9px;padding:2px 4px;border-radius:3px;color:white}.embed{margin:4px 0 8px 42px;max-width:560px;overflow-wrap:anywhere;background:#2b2d31;border-left:4px solid;border-radius:4px;padding:12px 16px;line-height:1.5}.embed h3{margin:0 0 6px;font-size:16px;color:#f2f3f5}.fields{display:flex;flex-wrap:wrap;gap:12px 18px;margin-top:12px}.field{width:100%}.field.inline{flex:1 1 180px;min-width:0}.field h4{font-size:13px;margin:0 0 2px}footer{display:flex;align-items:center;gap:8px;font-size:12px;color:#dbdee1;margin-top:12px}footer img{border-radius:50%;object-fit:cover}code{background:#1e1f22;border-radius:3px;padding:1px 4px;font-size:12px}.timestamp{background:#3f4147;border-radius:3px;padding:0 3px;font-size:12px}a{color:#00a8fc;text-decoration:none}.buttons{display:flex;gap:8px;margin:8px 0 0 42px}button{border:0;border-radius:3px;color:#fff;padding:8px 16px;font-weight:500;font-family:inherit;opacity:1}.danger{background:#da373c}.secondary{background:#4e5058}.attachment{max-width:560px;margin:8px 0 8px 42px;border:1px solid #232428;background:#2b2d31;border-radius:4px;padding:10px 12px}.attachment summary{cursor:pointer;color:#00a8fc}.attachment small{display:block;color:#949ba4;font-size:11px;margin-top:3px}.attachment pre{max-height:360px;overflow:auto;color:#dbdee1;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){body{padding:20px 12px}article{padding:16px}.embed,.buttons,.attachment{margin-left:0}}
    .thumbnail{float:right;width:88px;height:88px;margin:0 0 12px 16px}.thumbnail img{width:88px;height:88px;object-fit:cover;border-radius:3px}.embed:after{content:"";display:table;clear:both}
  </style><header><h1>Модерация VRChatRU</h1><p>Личные сообщения, подтверждения и mod-log</p></header>${panels}</html>`;
}

export function previewPublishingConfig(
  env: Record<string, string | undefined> = Bun.env,
): Pick<Config, "token" | "guildId" | "previewThreadId"> {
  const token = env.DISCORD_TOKEN?.trim();
  if (!token) throw new Error("DISCORD_TOKEN is required to publish previews");
  const id = (value: string | undefined, name: string) => {
    const result = value?.trim();
    if (
      !result ||
      !/^[1-9]\d{16,19}$/.test(result) ||
      BigInt(result) > 18_446_744_073_709_551_615n
    ) {
      throw new Error(`${name} must be a Discord snowflake ID`);
    }
    return result;
  };
  return {
    token,
    guildId: id(env.GUILD_ID, "GUILD_ID"),
    previewThreadId: id(
      env.PREVIEW_THREAD_ID || "1568864293712171018",
      "PREVIEW_THREAD_ID",
    ),
  };
}

async function sendPreviews(fixtures: Preview[]): Promise<void> {
  const config = previewPublishingConfig();
  const root = resolve(import.meta.dir, "..");
  const logger = createLogger(resolve(root, "discord-moderation-bot.log"), [
    config.token,
  ]);
  const store = new Store(resolve(root, "discord-moderation-bot.db"));
  const published: string[] = [];
  try {
    const rest = new REST({
      version: "10",
      timeout: 15_000,
      retries: 0,
    }).setToken(config.token);
    const channel = (await rest.get(
      Routes.channel(config.previewThreadId),
    )) as APIChannel;
    if (
      !("guild_id" in channel) ||
      channel.guild_id !== config.guildId ||
      ![10, 11, 12].includes(channel.type)
    ) {
      throw new Error("PREVIEW_THREAD_ID must reference a thread in GUILD_ID");
    }
    for (const fixture of fixtures) {
      const message = (await rest.post(
        Routes.channelMessages(config.previewThreadId),
        {
          body: {
            ...fixture.payload,
            content: [`**${fixture.label}**`, fixture.payload.content]
              .filter(Boolean)
              .join("\n"),
          },
          ...(fixture.files?.length
            ? {
                files: fixture.files.map((file) => ({
                  name: file.name,
                  data: Buffer.from(file.content, "utf8"),
                  contentType: "text/plain; charset=utf-8",
                })),
              }
            : {}),
        },
      )) as { id: string };
      published.push(message.id);
    }
    const data = {
      threadId: config.previewThreadId,
      count: published.length,
      messageIds: published,
    };
    store.audit("previews_published", data);
    logger.info("Published moderation previews", data);
    const link = (id: string) =>
      `https://discord.com/channels/${config.guildId}/${config.previewThreadId}/${id}`;
    console.info(
      `Published ${published.length} previews. First: ${link(published[0]!)} Last: ${link(published.at(-1)!)}`,
    );
  } catch (error) {
    const failure = error as { status?: number; code?: number };
    const data = {
      threadId: config.previewThreadId,
      count: published.length,
      messageIds: published,
      status: failure?.status ?? null,
      code: failure?.code ?? null,
    };
    store.audit("previews_publish_failed", data);
    logger.warn("Moderation preview publishing stopped", data);
    throw error;
  } finally {
    store.close();
    await logger.close();
  }
}

if (import.meta.main) {
  const fixtures = previewFixtures();
  const path = resolve(import.meta.dir, "..", "previews.html");
  await Bun.write(path, previewHtml(fixtures));
  console.info(`Created ${path} (${fixtures.length} previews)`);
  if (Bun.argv.includes("--json")) {
    await Bun.write(
      resolve(import.meta.dir, "..", "previews.json"),
      JSON.stringify(fixtures, null, 2),
    );
  }
  if (Bun.argv.includes("--send")) {
    try {
      await sendPreviews(fixtures);
    } catch (error) {
      const failure = error as { status?: number; code?: number };
      console.error(
        `Preview publishing failed (status: ${failure?.status ?? "network"}, code: ${failure?.code ?? "unknown"}). No automatic retry.`,
      );
      process.exitCode = 1;
    }
  }
}
