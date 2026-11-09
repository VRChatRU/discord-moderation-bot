import type { ModerationPlugin } from "../src/moderation.ts";

export default {
  name: "warn",
  async execute(_context, action) {
    return action.reason
      ? "Предупреждение сохранено. Уведомление будет отправлено в личные сообщения."
      : "Предупреждение сохранено без уведомления в личные сообщения.";
  },
} satisfies ModerationPlugin;
