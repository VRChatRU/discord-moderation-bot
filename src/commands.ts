import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  PermissionFlagsBits,
  Routes,
  SlashCommandBuilder,
  type REST,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import type { ActionKind } from "./types.ts";

const commandDetails: Record<
  ActionKind | "modlogs",
  { description: string; permission: bigint }
> = {
  mute: {
    description: "Ограничить общение ролью мьюта",
    permission: PermissionFlagsBits.ManageRoles,
  },
  kill: {
    description: "Забанить и удалить сообщения пользователя",
    permission: PermissionFlagsBits.BanMembers,
  },
  kick: {
    description: "Исключить пользователя с сервера",
    permission: PermissionFlagsBits.KickMembers,
  },
  ban: {
    description: "Забанить пользователя без удаления сообщений",
    permission: PermissionFlagsBits.BanMembers,
  },
  unban: {
    description: "Снять бан пользователя",
    permission: PermissionFlagsBits.BanMembers,
  },
  warn: {
    description: "Выдать предупреждение",
    permission: PermissionFlagsBits.ModerateMembers,
  },
  purge: {
    description: "Удалить последние сообщения в этом канале",
    permission: PermissionFlagsBits.ManageMessages,
  },
  scam: {
    description: "Заблокировать скам-аккаунт и удалить сообщения за сутки",
    permission: PermissionFlagsBits.BanMembers,
  },
  modlogs: {
    description: "Посмотреть историю модерации пользователя",
    permission: PermissionFlagsBits.ModerateMembers,
  },
};

export function commandDefinitions(): RESTPostAPIApplicationCommandsJSONBody[] {
  const definitions: RESTPostAPIApplicationCommandsJSONBody[] = [];
  for (const [name, detail] of Object.entries(commandDetails)) {
    const command = new SlashCommandBuilder()
      .setName(name)
      .setDescription(detail.description)
      .setDefaultMemberPermissions(detail.permission);
    if (name === "purge") {
      command.addIntegerOption((option) =>
        option
          .setName("number")
          .setDescription("Сколько последних сообщений удалить (1–100)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100),
      );
    } else {
      command
        .addUserOption((option) =>
          option.setName("user").setDescription("Пользователь сервера"),
        )
        .addStringOption((option) =>
          option
            .setName("userid")
            .setDescription("Discord ID пользователя")
            .setMinLength(17)
            .setMaxLength(20),
        );
      if (["mute", "kill", "ban"].includes(name)) {
        command.addNumberOption((option) =>
          option
            .setName("duration")
            .setDescription("Срок в днях; без значения — бессрочно")
            .setMinValue(1 / 1440)
            .setMaxValue(36500),
        );
      }
      if (["mute", "kill", "kick", "ban", "warn"].includes(name)) {
        command.addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Причина или номер правила (1–11)")
            .setMaxLength(1000),
        );
      }
    }
    definitions.push(command.toJSON());
  }
  definitions.push(
    new ContextMenuCommandBuilder()
      .setName("Зарепортить пользователя")
      .setType(ApplicationCommandType.Message)
      .setDefaultMemberPermissions(null)
      .toJSON(),
  );
  return definitions;
}

export async function registerCommands(
  rest: Pick<REST, "post">,
  applicationId: string,
  guildId: string,
): Promise<void> {
  // The application is shared: bulk overwrites would remove other processes' commands.
  for (const definition of commandDefinitions()) {
    await rest.post(Routes.applicationGuildCommands(applicationId, guildId), {
      body: definition,
    });
  }
}
