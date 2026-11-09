import { describe, expect, test } from "bun:test";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ComponentType,
} from "discord.js";
import { commandDefinitions } from "../src/commands.ts";
import {
  previewFixtures,
  previewHtml,
  previewPublishingConfig,
} from "../src/preview.ts";
import {
  actionDm,
  actionLog,
  bold,
  confirmation,
  dmEmbed,
  dmNotice,
  embedColor,
  logEmbed,
  logNotice,
  modlogs,
  reportPayload,
  userMention,
} from "../src/ui.ts";
import {
  actionKinds,
  type Action,
  type Config,
  type Report,
} from "../src/types.ts";

const config: Config = {
  token: "test",
  guildId: "100000000000000001",
  muteRoleId: "100000000000000002",
  modLogChannelId: "100000000000000003",
  textLogChannelId: "760706717188489226",
  botChannelId: "100000000000000004",
  inviteUrl: "https://vrcru.org/discord",
  moderatorRoleIds: [],
  kumaUrl: "https://example.org/push/test",
  rules: new Map(),
  previewThreadId: "1568864293712171018",
  scamAppealHours: 336,
  reportContext: "guild",
  killHistory: false,
};

function sampleAction(kind: Action["kind"] = "ban"): Action {
  return {
    id: "sample-case-uuid",
    interactionId: "123456789012345678",
    guildId: config.guildId,
    actorId: "223456789012345678",
    targetId: "323456789012345678",
    channelId: "423456789012345678",
    kind,
    reason: "Правило 3: Конь педальный.",
    durationDays: 48,
    count: 3,
    messageIds: [],
    reportId: null,
    createdAt: Date.now(),
    confirmUntil: Date.now() + 120000,
    completedAt: Date.now(),
    state: "succeeded",
    result: "Действие выполнено.",
  };
}

function embedLength(embed: {
  title?: string;
  description?: string;
  footer?: { text: string };
  fields?: { name: string; value: string }[];
}): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce(
      (sum, field) => sum + field.name.length + field.value.length,
      0,
    )
  );
}

describe("presentation", () => {
  test("all preview payloads fit Discord limits and have inert buttons", () => {
    const fixtures = previewFixtures();
    expect(fixtures.length).toBeGreaterThan(35);
    for (const { payload } of fixtures) {
      expect(payload.embeds!.length).toBeLessThanOrEqual(10);
      expect(
        payload.embeds!.reduce((sum, embed) => sum + embedLength(embed), 0),
      ).toBeLessThanOrEqual(6000);
      for (const embed of payload.embeds!) {
        expect(embed.description?.length ?? 0).toBeLessThanOrEqual(4096);
        expect(embed.fields?.length ?? 0).toBeLessThanOrEqual(25);
        for (const field of embed.fields ?? [])
          expect(field.value.length).toBeLessThanOrEqual(1024);
      }
      for (const row of payload.components ?? []) {
        if (row.type !== ComponentType.ActionRow) continue;
        for (const component of row.components)
          if (component.type === ComponentType.Button)
            expect(component.disabled).toBe(true);
      }
      expect(payload.allowed_mentions?.parse).toEqual([]);
    }
  });

  test("large reports fit the combined embed limit and retain all ten context entries", () => {
    const message = {
      id: "123456789012345678",
      channelId: "223456789012345678",
      authorId: "323456789012345678",
      authorName: "x".repeat(200),
      content: "**@everyone**".repeat(1000),
      attachments: ["https://cdn.discordapp.com/" + "x".repeat(2000)],
      createdAt: Date.now(),
    };
    const report: Report = {
      id: crypto.randomUUID(),
      interactionId: "423456789012345678",
      guildId: "523456789012345678",
      channelId: message.channelId,
      messageId: message.id,
      targetId: message.authorId,
      reporterId: "623456789012345678",
      reason: "*".repeat(1000),
      message,
      context: Array.from({ length: 10 }, (_, index) => ({
        ...message,
        id: String(700000000000000000n + BigInt(index)),
      })),
      createdAt: Date.now(),
      state: "open",
      modMessageId: null,
      resolvedBy: null,
      resolution: null,
      contextWarning: "*".repeat(1000),
      targetAvatarUrl:
        "https://cdn.discordapp.com/avatars/323456789012345678/avatar.png",
      reporterName: "Модератор",
    };
    const payload = reportPayload(report);
    const embeds = payload.embeds.map((embed) => embed.toJSON());
    expect(
      embeds.reduce((sum, embed) => sum + embedLength(embed), 0),
    ).toBeLessThanOrEqual(6000);
    expect(embeds).toHaveLength(1);
    const embed = embeds[0]!;
    expect(embed.color).toBe(0xff0000);
    expect(embed.title).toBe("[Ссылка на сообщение]");
    expect(embed.url).toBe(
      "https://discord.com/channels/523456789012345678/223456789012345678/123456789012345678",
    );
    expect(embed.thumbnail?.url).toBe(report.targetAvatarUrl!);
    expect(embed.footer?.text).toMatch(/^Жалоба • /);
    expect(embed.description).toContain("**<t:");
    expect(embed.description).not.toContain("приложенном файле");
    const history = embed
      .fields!.filter(
        (field) =>
          field.name === "Последние сообщения пользователя:" ||
          field.name === "\u200b",
      )
      .map((field) => field.value)
      .join("\n");
    for (let index = 0; index < 10; index++)
      expect(history).toContain(String(700000000000000000n + BigInt(index)));
    expect(history).not.toContain("<#");
    for (const field of embed.fields!)
      expect(field.value.length).toBeLessThanOrEqual(1024);
    expect(
      embed.fields!.some(
        (field) => field.name === "История может быть неполной:",
      ),
    ).toBe(true);
    expect(
      embed.fields!.find((field) => field.name === "Пользователь:")!.value,
    ).toContain("ID: **323456789012345678**");
    expect(payload.components).toHaveLength(1);
    const processing = reportPayload({
      ...report,
      state: "processing",
    }).components[0]!.components.map((button) => button.toJSON());
    expect(processing[0]!.disabled).toBe(true);
    expect(processing[1]!.disabled).toBe(false);
    const resolved = reportPayload({
      ...report,
      state: "resolved",
      resolution: "*".repeat(1000),
      resolvedBy: "623456789012345678",
    });
    expect(resolved.components).toHaveLength(1);
    expect(
      resolved.components[0]!.components.map((button) => button.toJSON()),
    ).toMatchObject([{ label: "Решено", disabled: true }]);
    expect(
      resolved.embeds[0]!.toJSON().fields?.some(
        (field) => field.name === "Решение:",
      ),
    ).toBe(false);
    for (const resolution of [
      "Скам-аккаунт заблокирован.",
      "Аккаунт заблокирован как скаммер.",
      "Скам-бан подтверждён после восстановления.",
    ]) {
      const banned = reportPayload({
        ...report,
        state: "resolved",
        resolution,
      });
      expect(
        banned.components[0]!.components.map((button) => button.toJSON()),
      ).toMatchObject([{ label: "Забанен за скам", disabled: true }]);
      expect(banned.embeds[0]!.toJSON().fields).toEqual(
        resolved.embeds[0]!.toJSON().fields,
      );
    }
    expect(
      resolved.embeds.reduce(
        (sum, embed) => sum + embedLength(embed.toJSON()),
        0,
      ),
    ).toBeLessThanOrEqual(6000);
  });

  test("commands expose the requested options with private moderator defaults", () => {
    const commands = commandDefinitions();
    expect(commands).toHaveLength(10);
    const report = commands.find(
      (command) => command.type === ApplicationCommandType.Message,
    )!;
    expect(report.name).toBe("Зарепортить пользователя");
    expect(report.default_member_permissions).toBeNull();
    const purge = commands.find((command) => command.name === "purge")!;
    expect("options" in purge && purge.options?.[0]).toMatchObject({
      name: "number",
      type: ApplicationCommandOptionType.Integer,
      required: true,
      min_value: 1,
      max_value: 100,
    });
    for (const command of commands.filter(
      (command) => command.type !== ApplicationCommandType.Message,
    ))
      expect(command.default_member_permissions).toBeTruthy();
  });

  test("scam notification explains the exact phrase and fourteen-day delay", () => {
    const sample = previewFixtures().find(
      (fixture) => fixture.label === "/scam · личное сообщение",
    )!;
    const content = sample.payload
      .embeds!.map((embed) => embed.description ?? "")
      .join("\n");
    expect(content).toContain("Через **14 дней** после блокировки");
    expect(content).toContain(
      "Я избавился от вирусов и поменял пароль в Discord, пустите меня обратно",
    );
    expect(content.endsWith("Мы автоматически снимем вам бан.")).toBe(true);
    expect(
      actionDm(sampleAction("unban"), "VRChatRU", config).toJSON().description,
    ).toContain("[Вернуться на сервер](<https://vrcru.org/discord>)");
  });

  test("all personal messages use the exact reference style", () => {
    for (const embed of [
      ...actionKinds.map((kind) =>
        actionDm(sampleAction(kind), "VRChatRU", config),
      ),
      dmNotice("Доступ восстановлен."),
    ]) {
      const json = embed.toJSON();
      expect(json.title).toBe("Внимание!");
      expect(json.color).toBe(15844379);
      expect(json.footer).toEqual({
        text: "Модерация VRChatRU",
        icon_url: "https://i.imgur.com/72pQbbd.png",
      });
      expect(Object.keys(json).sort()).toEqual([
        "color",
        "description",
        "footer",
        "title",
      ]);
      expect(json.description).not.toContain("sample-case-uuid");
      expect(json.description).not.toContain("VRChatRU");
      expect(json.description).not.toContain("за 7 дней");
      expect(json.description).not.toContain("за 1 день");
    }
  });

  test("moderation logs contain only color and concise description", () => {
    for (const embed of [
      ...actionKinds.map((kind) => actionLog(sampleAction(kind))),
      logNotice("Бот подключён."),
      ...modlogs([sampleAction()], sampleAction().targetId!, 0).embeds,
    ]) {
      const json = embed.toJSON();
      expect(Object.keys(json).sort()).toEqual(["color", "description"]);
      expect(json.color).toBe(embedColor);
      expect(json.description).not.toContain("sample-case-uuid");
      expect(json.description).not.toContain("Действие выполнено");
      expect(json.description).not.toMatch(/· `\d{17,20}`/);
    }
    expect(
      actionLog({
        ...sampleAction("purge"),
        state: "uncertain",
        result:
          "Удалено 2 из 3 сообщений. Результат последнего запроса неизвестен.",
      }).toJSON().description,
    ).toContain("Удалено 2 из 3 сообщений");
  });

  test("confirmation is the requested short action and reason with unchanged buttons", () => {
    const action = sampleAction();
    const payload = confirmation(action, config);
    expect(payload.embeds[0]!.toJSON()).toEqual({
      color: embedColor,
      title: "Вы уверенны?",
      description:
        "Забанить **<@323456789012345678>** на **48 дней**.\nПричина: **Правило 3. Конь педальный.**",
    });
    expect(
      payload.components[0]!.components.map((button) => button.toJSON()),
    ).toMatchObject([
      { custom_id: "confirm:sample-case-uuid", label: "Подтвердить" },
      { custom_id: "cancel:sample-case-uuid", label: "Отмена" },
    ]);
    expect(
      confirmation(
        { ...action, reason: null, durationDays: null },
        config,
      ).embeds[0]!.toJSON().description,
    ).toBe("Забанить **<@323456789012345678>** **бессрочно**.");
    for (const [days, term] of [
      [1, "1 день"],
      [2, "2 дня"],
      [5, "5 дней"],
      [11, "11 дней"],
      [21, "21 день"],
    ] as const) {
      expect(
        confirmation(
          { ...action, durationDays: days },
          config,
        ).embeds[0]!.toJSON().description,
      ).toContain(term);
    }
    expect(
      confirmation(sampleAction("kill"), config).embeds[0]!.toJSON(),
    ).toEqual(confirmation(action, config).embeds[0]!.toJSON());
    expect(
      confirmation(sampleAction("scam"), config).embeds[0]!.toJSON()
        .description,
    ).not.toContain("удалить");
  });

  test("action text has bold variables, identical ban and kill, and no success actor", () => {
    const action = sampleAction();
    expect(bold("48 дней")).toBe("**48 дней**");
    expect(bold("**48 дней**")).toBe("**48 дней**");
    expect(userMention(action.targetId!)).toBe("**<@323456789012345678>**");
    expect(
      actionDm(sampleAction("mute"), "Unused server", config).toJSON()
        .description,
    ).toBe(
      "Вы были заглушены на **48 дней**.\nПричина: **Правило 3. Конь педальный.**",
    );
    expect(actionLog(sampleAction("mute")).toJSON().description).toBe(
      "**<@323456789012345678>** заглушен на **48 дней**.\nПричина: **Правило 3. Конь педальный.**",
    );
    expect(
      actionDm(sampleAction("kill"), "Unused server", config).toJSON(),
    ).toEqual(actionDm(action, "Unused server", config).toJSON());
    expect(actionLog(sampleAction("kill")).toJSON()).toEqual(
      actionLog(action).toJSON(),
    );
    expect(
      actionDm(sampleAction("kick"), "Unused server", config).toJSON()
        .description,
    ).toStartWith("Вас кикнули.");
    for (const kind of actionKinds)
      expect(actionLog(sampleAction(kind)).toJSON().description).not.toContain(
        action.actorId,
      );
  });

  test("legacy embed normalization preserves meaning while removing obsolete decoration", () => {
    const legacy = {
      title: "Не доставлено",
      description: "<@323456789012345678> · `323456789012345678`",
      fields: [{ name: "Причина", value: "Закрыты личные сообщения." }],
      footer: { text: "Старый UUID" },
      timestamp: new Date().toISOString(),
      color: 123,
    };
    const log = logEmbed(legacy);
    expect(log).toEqual({
      color: embedColor,
      description:
        "Не доставлено\n<@323456789012345678>\nПричина: Закрыты личные сообщения.",
    });
    expect(logEmbed(log)).toEqual(log);
    const dm = dmEmbed(legacy);
    expect(dm.title).toBe("Внимание!");
    expect(dm.description).toBe(log.description);
    expect(dmEmbed(dm)).toEqual(dm);
  });

  test("HTML previews escape user content", () => {
    const html = previewHtml([
      {
        label: "<script>evil()</script>",
        payload: {
          embeds: [
            { title: "<img src=x onerror=evil()>", description: "**Safe**" },
          ],
        },
      },
    ]);
    expect(html).not.toContain("<script>evil()");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("<strong>Safe</strong>");
  });

  test("publishing previews needs only publishing credentials", () => {
    expect(
      previewPublishingConfig({
        DISCORD_TOKEN: "test",
        GUILD_ID: "123456789012345678",
      }),
    ).toEqual({
      token: "test",
      guildId: "123456789012345678",
      previewThreadId: "1568864293712171018",
    });
    expect(() =>
      previewPublishingConfig({ DISCORD_TOKEN: "test", GUILD_ID: "not-an-id" }),
    ).toThrow("GUILD_ID");
    expect(() =>
      previewPublishingConfig({ GUILD_ID: "123456789012345678" }),
    ).toThrow("DISCORD_TOKEN");
  });
});
