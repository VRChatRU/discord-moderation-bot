import {
  actionStartedAt,
  sanctionFor,
  type ModerationPlugin,
} from "../src/moderation.ts";

export default {
  name: "mute",
  async execute(context, action) {
    await context.target!.roles.add(
      context.config.muteRoleId,
      context.auditReason,
    );
    context.store.setSanction(
      sanctionFor(
        action,
        context.config,
        actionStartedAt(context.store, action),
      ),
    );
    return action.durationDays === null
      ? "Роль mute выдана бессрочно."
      : `Роль mute выдана на ${action.durationDays} дн.`;
  },
} satisfies ModerationPlugin;
