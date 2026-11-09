import { describe, expect, test } from "bun:test";
import { previewFixtures, previewHtml } from "../src/preview.ts";

describe("preview gallery", () => {
  test("uses readable sample names without Discord mentions or numbered banners", () => {
    const fixtures = previewFixtures();
    const payloads = JSON.stringify(fixtures.map((fixture) => fixture.payload));
    expect(payloads).toContain("User42");
    expect(payloads).toContain("Moderator1337");
    expect(payloads).not.toMatch(/<@!?\d+>|<@&\d+>|<#\d+>/);
    expect(fixtures.every((fixture) => !fixture.label.includes("Макет"))).toBe(
      true,
    );
    const confirmation = fixtures.find(
      (fixture) => fixture.label === "/ban · подтверждение",
    )!;
    expect(confirmation.payload.embeds![0]!.title).toBe("Вы уверенны?");
    expect(confirmation.payload.embeds![0]!.description).toContain("48");
    expect(confirmation.payload.embeds![0]!.description).toContain(
      "**48 дней**",
    );
    expect(confirmation.payload.embeds![0]!.description).toContain(
      `**[User42](https://discord.com/users/100000000000000012)**`,
    );
    expect(
      fixtures.some((fixture) => fixture.label === "Репорт · подтверждение"),
    ).toBe(false);
    expect(
      fixtures
        .filter((fixture) => fixture.label.startsWith("Обращение ·"))
        .map((fixture) => fixture.label),
    ).toEqual(["Обращение · доступ восстановлен"]);
  });

  test("report fixtures keep their red embed and avatar without attaching transcripts", () => {
    const reports = previewFixtures().filter((fixture) =>
      [
        "Репорт · новый",
        "Репорт · обрабатывается",
        "Репорт · решено",
        "Репорт · забанен за скам",
      ].includes(fixture.label),
    );
    expect(reports).toHaveLength(4);
    for (const report of reports) {
      expect(report.files).toBeUndefined();
      expect(report.payload.attachments).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain("report-preview-report.txt");
      expect(report.payload.embeds).toHaveLength(1);
      expect(report.payload.embeds![0]!.color).toBe(0xff0000);
      expect(report.payload.embeds![0]!.thumbnail?.url).toBe(
        "https://cdn.discordapp.com/embed/avatars/0.png",
      );
    }
    for (const [label, status] of [
      ["Репорт · решено", "Решено"],
      ["Репорт · забанен за скам", "Забанен за скам"],
    ] as const) {
      const resolved = reports.find((report) => report.label === label)!;
      expect(resolved.payload.components).toHaveLength(1);
      expect(resolved.payload.components![0]).toMatchObject({
        components: [{ label: status, disabled: true }],
      });
      expect(
        resolved.payload.embeds![0]!.fields?.some(
          (field) => field.name === "Решение:",
        ),
      ).toBe(false);
    }
  });

  test("renders footer icons and safe optional files while leaving plain logs undecorated", () => {
    const fixtures = previewFixtures();
    const html = previewHtml(fixtures);
    expect(html).toContain('<img src="https://i.imgur.com/72pQbbd.png"');
    expect(html).toContain("Модерация VRChatRU</span></footer>");
    expect(html).not.toContain("report-preview-report.txt");
    expect(html).not.toContain("<h3></h3>");
    expect(html).not.toContain("<footer></footer>");
    expect(html).not.toContain("Серые, янтарные");
    expect(html).toContain('<aside class="thumbnail">');
    const log = fixtures.find((fixture) => fixture.label === "/ban · mod-log")!;
    const logHtml = previewHtml([log]);
    expect(logHtml).not.toContain("<h3>");
    expect(logHtml).not.toContain("<footer>");
    const escaped = previewHtml([
      {
        label: "Transcript",
        payload: {
          embeds: [
            {
              title: "Safe title",
              url: "javascript:alert(1)",
              description: "Safe",
              footer: { text: "Safe", icon_url: "javascript:alert(1)" },
            },
          ],
        },
        files: [{ name: "<script>.txt", content: "<script>alert(1)</script>" }],
      },
    ]);
    expect(escaped).not.toContain("<script>");
    expect(escaped).not.toContain("javascript:");
    expect(escaped).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
