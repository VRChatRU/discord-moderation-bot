import { banTarget } from "./ban.ts";
import type { ModerationPlugin } from "../src/moderation.ts";

export default {
  name: "kill",
  async execute(context, action) {
    await banTarget(context, action, 604800);
    const duration =
      action.durationDays === null
        ? "бессрочно"
        : `на ${action.durationDays} дн.`;
    return `Пользователь заблокирован ${duration}. Сообщения за последние 7 дней удалены.`;
  },
} satisfies ModerationPlugin;
