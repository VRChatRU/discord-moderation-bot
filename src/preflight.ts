import { ApplicationFlagsBitField, PermissionFlagsBits } from "discord.js";
import { loadConfig } from "./config.ts";
import { createClient } from "./bot.ts";
import { errorCode, errorStatus } from "./notifications.ts";

// Read-only check: no command registration, messages or moderation mutations.
export async function preflight(): Promise<void> {
  const config = loadConfig();
  const client = createClient();
  client.on("error", () => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.login(config.token),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Gateway connection timed out")),
          25_000,
        );
      }),
    ]);
    const guild = await client.guilds.fetch(config.guildId);
    const [bot, roles, application] = await Promise.all([
      guild.members.fetchMe({ force: true }),
      guild.roles.fetch(),
      client.application!.fetch(),
    ]);
    const mute = roles.get(config.muteRoleId);
    const problems: string[] = [];
    if (!mute) problems.push("Mute role does not exist");
    else if (mute.managed || bot.roles.highest.comparePositionTo(mute) <= 0)
      problems.push("Mute role must be unmanaged and below the bot role");
    for (const id of config.moderatorRoleIds)
      if (!roles.has(id)) problems.push(`Moderator role ${id} does not exist`);
    const required = [
      "ManageRoles",
      "BanMembers",
      "KickMembers",
      "ManageMessages",
      "ViewAuditLog",
    ] as const;
    for (const name of required)
      if (!bot.permissions.has(PermissionFlagsBits[name]))
        problems.push(`Missing guild permission: ${name}`);
    for (const [label, id] of [
      ["mod-log", config.modLogChannelId],
      ["text-log", config.textLogChannelId],
      ["bot", config.botChannelId],
    ] as const) {
      const channel = await guild.channels.fetch(id);
      if (!channel?.isTextBased()) {
        problems.push(`${label} channel is missing or is not text-based`);
        continue;
      }
      const requiredChannel = [
        "ViewChannel",
        "ReadMessageHistory",
        "EmbedLinks",
        ...(label === "mod-log" || label === "text-log"
          ? ["AttachFiles" as const]
          : []),
        channel.isThread() ? "SendMessagesInThreads" : "SendMessages",
      ] as const;
      for (const name of requiredChannel)
        if (!bot.permissionsIn(channel).has(PermissionFlagsBits[name]))
          problems.push(`Missing ${label} channel permission: ${name}`);
      if (label === "mod-log") {
        const firstRoleId = config.moderatorRoleIds[0];
        const role = firstRoleId ? roles.get(firstRoleId) : undefined;
        if (
          role &&
          !role.mentionable &&
          !bot.permissionsIn(channel).has(PermissionFlagsBits.MentionEveryone)
        ) {
          problems.push(
            "Report role is not mentionable and bot lacks MentionEveryone in mod-log",
          );
        }
      }
    }
    const flags = application.flags;
    const content =
      flags.has(ApplicationFlagsBitField.Flags.GatewayMessageContent) ||
      flags.has(ApplicationFlagsBitField.Flags.GatewayMessageContentLimited);
    const members =
      flags.has(ApplicationFlagsBitField.Flags.GatewayGuildMembers) ||
      flags.has(ApplicationFlagsBitField.Flags.GatewayGuildMembersLimited);
    if (!content)
      problems.push("Enable Message Content Intent in the Developer Portal");
    if (!members)
      problems.push("Enable Server Members Intent in the Developer Portal");
    console.log(
      JSON.stringify({
        guildId: guild.id,
        botId: bot.id,
        connected: true,
        checked: ["roles", "permissions", "channels", "intents"],
        problems,
      }),
    );
    if (problems.length) process.exitCode = 1;
  } catch (error) {
    // Discord errors may contain URLs with tokens; never print the raw object.
    console.error(
      JSON.stringify({
        connected: false,
        status: errorStatus(error),
        code: errorCode(error),
        error:
          "Preflight failed. Check connectivity, token, guild access and enabled privileged intents.",
      }),
    );
    process.exitCode = 1;
  } finally {
    if (timeout) clearTimeout(timeout);
    await client.destroy();
  }
}

if (import.meta.main) await preflight();
