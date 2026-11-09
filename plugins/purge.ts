import {
  discordCode,
  isPermanentError,
  UserFacingError,
  type ModerationPlugin,
} from "../src/moderation.ts";

export class PurgePartialError extends Error {
  constructor(
    readonly deleted: number,
    readonly requested: number,
    readonly uncertain: boolean,
    options?: ErrorOptions,
  ) {
    super(
      `Удалено ${deleted} из ${requested} сообщений.${uncertain ? " Результат последнего запроса неизвестен. Не повторяйте удаление вслепую." : " Остальные сообщения не удалены."}`,
      options,
    );
    this.name = "PurgePartialError";
  }
}

export default {
  name: "purge",
  async execute(context, action) {
    const channel = await context.guild.channels.fetch(action.channelId, {
      force: true,
    });
    if (!channel?.isTextBased() || !("messages" in channel))
      throw new UserFacingError("Канал больше недоступен.");
    let deleted = 0;
    let absent = 0;
    const completed: string[] = [];
    const saveProgress = () =>
      context.store.setActionResult(
        action.id,
        `Удалено ${deleted} из ${action.messageIds.length} сообщений; уже отсутствовало: ${absent}.`,
      );
    const recentBoundary =
      BigInt(Date.now() - 1_209_600_000 + 60_000 - 1_420_070_400_000) << 22n;
    const recent = action.messageIds.filter(
      (id) => BigInt(id) > recentBoundary,
    );
    const individually = action.messageIds.filter(
      (id) => BigInt(id) <= recentBoundary,
    );
    const fail = (error: unknown): never => {
      saveProgress();
      context.store.audit("purge.partial", {
        actionId: action.id,
        deleted,
        absent,
        completed,
        remaining: action.messageIds.filter(
          (value) => !completed.includes(value),
        ),
      });
      const uncertain = !isPermanentError(error);
      throw new PurgePartialError(
        deleted,
        action.messageIds.length,
        uncertain,
        { cause: error },
      );
    };
    if (recent.length > 1 && "bulkDelete" in channel) {
      try {
        context.assertActive();
        await channel.bulkDelete(recent);
        deleted += recent.length;
        completed.push(...recent);
        saveProgress();
      } catch (error) {
        fail(error);
      }
    } else {
      individually.push(...recent);
    }
    for (const id of individually) {
      try {
        context.assertActive();
        // Individual deletion supports messages older than two weeks and never expands the confirmed snapshot.
        await channel.messages.delete(id);
        deleted++;
        completed.push(id);
        saveProgress();
      } catch (error) {
        if (discordCode(error) === 10008) {
          absent++;
          completed.push(id);
          saveProgress();
          continue;
        }
        fail(error);
      }
    }
    context.store.audit("purge.completed", {
      actionId: action.id,
      deleted,
      absent,
      messageIds: action.messageIds,
    });
    return `Удалено ${deleted} сообщений.${absent ? ` Ещё ${absent} уже были удалены.` : ""}`;
  },
} satisfies ModerationPlugin;
