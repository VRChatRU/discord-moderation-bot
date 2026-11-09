import { banTarget } from "./ban.ts";
import type { ModerationPlugin } from "../src/moderation.ts";

export default {
  name: "scam",
  async execute(context, action) {
    await banTarget(context, action, 86400);
    return "Пользователь заблокирован бессрочно. Сообщения за последние 24 часа удалены.";
  },
} satisfies ModerationPlugin;
