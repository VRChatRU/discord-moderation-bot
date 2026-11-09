import type { ModerationPlugin } from "../src/moderation.ts";

export default {
  name: "unban",
  async execute(context, action) {
    await context.guild.members.unban(action.targetId!, context.auditReason);
    context.store.removeSanction(action.guildId, action.targetId!, "ban");
    return "Блокировка снята. Пользователь может снова присоединиться к серверу.";
  },
} satisfies ModerationPlugin;
