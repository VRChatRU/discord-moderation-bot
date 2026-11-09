import type { ModerationPlugin } from "../src/moderation.ts";

export default {
  name: "kick",
  async execute(context) {
    await context.target!.kick(context.auditReason);
    return "Пользователь исключён с сервера.";
  },
} satisfies ModerationPlugin;
