import {
  actionStartedAt,
  sanctionFor,
  type ModerationContext,
  type ModerationPlugin,
} from "../src/moderation.ts";
import type { Action } from "../src/types.ts";

export async function banTarget(
  context: ModerationContext,
  action: Action,
  deleteMessageSeconds: number,
): Promise<void> {
  await context.guild.members.ban(action.targetId!, {
    deleteMessageSeconds,
    reason: context.auditReason,
  });
  context.store.setSanction(
    sanctionFor(action, context.config, actionStartedAt(context.store, action)),
  );
}

export default {
  name: "ban",
  async execute(context, action) {
    await banTarget(context, action, 0);
    return action.durationDays === null
      ? "Пользователь заблокирован бессрочно. Сообщения сохранены."
      : `Пользователь заблокирован на ${action.durationDays} дн. Сообщения сохранены.`;
  },
} satisfies ModerationPlugin;
