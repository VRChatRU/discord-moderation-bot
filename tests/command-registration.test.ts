import { describe, expect, mock, test } from "bun:test";
import type { REST } from "discord.js";
import { commandDefinitions, registerCommands } from "../src/commands.ts";

const applicationId = "681203698923601965";
const guildId = "666306330230915093";

describe("shared application command registration", () => {
  test("upserts moderation commands individually without replacing the shared command list", async () => {
    const post = mock(async (_route: string, _options: unknown) => ({}));
    const rest = { post } as unknown as Pick<REST, "post">;
    await registerCommands(rest, applicationId, guildId);
    expect(post.mock.calls.map(([route]) => route)).toEqual(
      commandDefinitions().map(
        () => `/applications/${applicationId}/guilds/${guildId}/commands`,
      ),
    );
    expect(
      post.mock.calls.map(([, options]) => (options as { body: unknown }).body),
    ).toEqual(commandDefinitions());
    expect(
      post.mock.calls.every(
        ([, options]) => !Array.isArray((options as { body: unknown }).body),
      ),
    ).toBe(true);
  });

  test("a partial registration can retry safely using the same owned command keys", async () => {
    const post = mock(async (_route: string, _options: unknown) => ({}));
    post.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Offline"));
    const rest = { post } as unknown as Pick<REST, "post">;
    await expect(
      registerCommands(rest, applicationId, guildId),
    ).rejects.toThrow("Offline");
    expect(post).toHaveBeenCalledTimes(2);
    await registerCommands(rest, applicationId, guildId);
    expect(
      post.mock.calls
        .slice(2)
        .map(([, options]) => (options as { body: unknown }).body),
    ).toEqual(commandDefinitions());
  });
});
