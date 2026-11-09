import type { Client, Message } from "discord.js";
import type { Store } from "./store.ts";
import type { Control } from "./control.ts";
import type { Notifications } from "./notifications.ts";
import { errorCode, permanent } from "./notifications.ts";
import { actionStartedAt, caseMarker, fetchBan } from "./moderation.ts";
import { dmNotice, logNotice } from "./ui.ts";
import { scamAppealPhrase, type Config, type Logger } from "./types.ts";

export function isAppeal(content: string): boolean {
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .trim()
      .replace(/^[«"“]+|[»"”.!]+$/g, "")
      .trim()
      .replace(/\s+/g, " ")
      .toLocaleLowerCase("ru");
  return normalize(content) === normalize(scamAppealPhrase);
}

export class Appeals {
  private busy = false;
  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly control: Control,
    private readonly notifications: Notifications,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS appeals (
            ban_action_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action_id TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending', next_attempt_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS appeals_due ON appeals(state,next_attempt_at);
        CREATE UNIQUE INDEX IF NOT EXISTS appeals_action ON appeals(action_id);`);
    this.discardLegacyReplies();
  }

  private discardLegacyReplies(): void {
    const legacy = new Set([
      "Проверяем блокировку…",
      "Не удалось снять бан автоматически. Обратитесь к модератору.",
      "Автоматический разбан отменён. Обратитесь к модератору.",
      "Бан изменён. Обратитесь к модератору.",
      "Обратитесь к модератору для снятия бана.",
      "Бот проверит блокировку и пришлёт приглашение после снятия бана.",
      "Автоматическая проверка этого бана отменена. Обращение передано модераторам.",
      "Блокировка была изменена. Бот передал обращение модераторам для ручного разбора.",
      "Блокировка была изменена. Обращение передано модераторам.",
      "Обращение ожидает ручной проверки модератором.",
      "Для вашего аккаунта нет активной скам-блокировки, которую бот может снять автоматически. Обращение передано модераторам.",
    ]);
    const removed: string[] = [];
    this.store.db.transaction(() => {
      const queued = this.store.db
        .query<{ id: string; payload: string }, []>(
          "SELECT id,payload FROM outbox WHERE kind='dm' AND id NOT LIKE 'appeal-invite:%'",
        )
        .all();
      for (const item of queued) {
        const payload = JSON.parse(item.payload) as {
          embeds?: Array<{ description?: unknown }>;
        } | null;
        const descriptions = Array.isArray(payload?.embeds)
          ? payload.embeds
              .map((embed) => embed?.description)
              .filter((value): value is string => typeof value === "string")
          : [];
        if (
          !item.id.startsWith("appeal-reply:") &&
          !item.id.startsWith("appeal-cancelled:") &&
          !descriptions.some(
            (value) =>
              legacy.has(value.trim()) ||
              /^(?:Напишите эту фразу|Повторите сообщение) <t:\d+:[fR]>/.test(
                value.trim(),
              ),
          )
        )
          continue;
        this.store.completeOutbox(item.id);
        removed.push(item.id);
      }
      if (removed.length)
        this.store.audit("legacy_appeal_replies_discarded", { ids: removed });
    })();
    if (removed.length)
      this.logger.info("Discarded obsolete appeal replies", {
        count: removed.length,
      });
  }

  async receive(message: Message): Promise<void> {
    if (!isAppeal(message.content)) return;
    const sanction = this.store.getSanction(
      this.config.guildId,
      message.author.id,
      "ban",
    );
    const banAction = sanction ? this.store.getAction(sanction.actionId) : null;
    if (
      !banAction ||
      banAction.kind !== "scam" ||
      banAction.state !== "succeeded"
    ) {
      this.store.audit("appeal_untracked", { userId: message.author.id });
      return;
    }
    const eligibleAt =
      actionStartedAt(this.store, banAction) +
      this.config.scamAppealHours * 3_600_000;
    if (Date.now() < eligibleAt) {
      this.store.audit("appeal_too_early", {
        userId: message.author.id,
        actionId: banAction.id,
      });
      return;
    }
    this.store.db.transaction(() => {
      const existing = this.store.db
        .query<{ state: string }, [string]>(
          "SELECT state FROM appeals WHERE ban_action_id=?",
        )
        .get(banAction.id);
      if (existing) return;
      const now = Date.now();
      const action = this.store.createAction({
        id: crypto.randomUUID(),
        interactionId: `appeal:${banAction.id}`,
        guildId: this.config.guildId,
        actorId: this.client.user!.id,
        targetId: message.author.id,
        channelId: this.config.modLogChannelId,
        kind: "unban",
        reason: "Восстановление аккаунта",
        durationDays: null,
        count: null,
        reportId: null,
        createdAt: now,
        confirmUntil: now + 365 * 86_400_000,
        messageIds: [],
      });
      this.store.db
        .query(
          "INSERT INTO appeals(ban_action_id,user_id,action_id) VALUES(?,?,?)",
        )
        .run(banAction.id, message.author.id, action.id);
      this.store.audit("appeal_received", {
        userId: message.author.id,
        banActionId: banAction.id,
        actionId: action.id,
      });
    })();
  }

  isAutomatic(actionId: string): boolean {
    return !!this.store.db
      .query("SELECT 1 FROM appeals WHERE action_id=?")
      .get(actionId);
  }

  async tick(): Promise<void> {
    if (this.busy || !this.client.isReady()) return;
    const request = this.store.db
      .query<
        {
          ban_action_id: string;
          action_id: string;
          user_id: string;
          attempts: number;
        },
        [number]
      >(
        "SELECT * FROM appeals WHERE state='pending' AND next_attempt_at<=? LIMIT 1",
      )
      .get(Date.now());
    if (!request) return;
    this.busy = true;
    try {
      await this.control.locked(
        `${this.config.guildId}:${request.user_id}`,
        async () => {
          const current = this.store.db
            .query<{ state: string }, [string]>(
              "SELECT state FROM appeals WHERE ban_action_id=?",
            )
            .get(request.ban_action_id);
          if (current?.state !== "pending") return;
          const action = this.store.getAction(request.action_id);
          const original = this.store.getAction(request.ban_action_id);
          if (
            !action ||
            !original ||
            original.kind !== "scam" ||
            original.state !== "succeeded" ||
            original.targetId !== request.user_id ||
            original.guildId !== this.config.guildId ||
            !["pending", "running"].includes(action.state)
          ) {
            this.store.db.transaction(() => {
              if (action && ["pending", "running"].includes(action.state)) {
                this.store.finishAction(
                  action.id,
                  "failed",
                  "Исходная скам-блокировка недоступна; автоматический разбан отменён.",
                );
                this.notifications.actionLog(
                  this.store.getAction(action.id)!,
                  `appeal-cancelled-log:${action.id}`,
                );
              }
              this.store.db
                .query(
                  "UPDATE appeals SET state='cancelled' WHERE ban_action_id=?",
                )
                .run(request.ban_action_id);
              this.store.audit("appeal_cancelled", {
                userId: request.user_id,
                actionId: request.action_id,
              });
            })();
            return;
          }
          const eligibleAt =
            actionStartedAt(this.store, original) +
            this.config.scamAppealHours * 3_600_000;
          if (Date.now() < eligibleAt) {
            this.store.db
              .query(
                "UPDATE appeals SET next_attempt_at=? WHERE ban_action_id=?",
              )
              .run(eligibleAt, request.ban_action_id);
            return;
          }
          const sanction = this.store.getSanction(
            this.config.guildId,
            request.user_id,
            "ban",
          );
          const guild = await this.client.guilds.fetch(this.config.guildId);
          const ban = await fetchBan(guild, request.user_id);
          if (
            (sanction && sanction.actionId !== request.ban_action_id) ||
            (ban &&
              (!sanction ||
                !ban.reason?.includes(caseMarker(request.ban_action_id))))
          ) {
            this.store.db.transaction(() => {
              this.store.finishAction(
                action.id,
                "failed",
                "Блокировка изменена модератором; автоматический разбан отменён.",
              );
              this.store.db
                .query(
                  "UPDATE appeals SET state='cancelled' WHERE ban_action_id=?",
                )
                .run(request.ban_action_id);
              this.notifications.actionLog(
                this.store.getAction(action.id)!,
                `appeal-cancelled-log:${action.id}`,
              );
              this.store.audit("appeal_cancelled", {
                userId: request.user_id,
                actionId: action.id,
              });
            })();
            return;
          }
          if (
            action.state === "pending" &&
            !this.store.claimAction(action.id, action.actorId)
          ) {
            this.store.db.transaction(() => {
              this.store.finishAction(
                action.id,
                "expired",
                "Время автоматического разбора обращения истекло.",
              );
              this.store.db
                .query(
                  "UPDATE appeals SET state='cancelled' WHERE ban_action_id=?",
                )
                .run(request.ban_action_id);
              this.notifications.actionLog(
                this.store.getAction(action.id)!,
                `appeal-cancelled-log:${action.id}`,
              );
              this.store.audit("appeal_cancelled", {
                userId: request.user_id,
                actionId: action.id,
              });
            })();
            return;
          }
          if (ban)
            await guild.members.unban(
              request.user_id,
              `Account recovery ${caseMarker(action.id)}`,
            );
          this.store.db.transaction(() => {
            this.store.removeSanction(
              this.config.guildId,
              request.user_id,
              "ban",
              request.ban_action_id,
            );
            this.store.finishAction(action.id, "succeeded", "Скам-бан снят.");
            this.store.db
              .query("UPDATE appeals SET state='done' WHERE ban_action_id=?")
              .run(request.ban_action_id);
            this.notifications.actionLog(
              this.store.getAction(action.id)!,
              `appeal-log:${action.id}`,
            );
            this.store.enqueue(
              "dm",
              {
                targetId: request.user_id,
                actionId: action.id,
                template: "unban",
                embeds: [
                  dmNotice(
                    `Бан снят. [**Вернуться на сервер**](${this.config.inviteUrl})`,
                  ).toJSON(),
                ],
              },
              `appeal-invite:${action.id}`,
            );
            this.store.audit("appeal_accepted", {
              actionId: action.id,
              userId: request.user_id,
            });
          })();
          this.logger.info("Scam appeal accepted", {
            actionId: action.id,
            userId: request.user_id,
          });
        },
      );
    } catch (error) {
      const attempts = request.attempts + 1;
      this.store.db
        .query(
          "UPDATE appeals SET attempts=?,next_attempt_at=? WHERE ban_action_id=?",
        )
        .run(
          attempts,
          Date.now() + Math.min(3_600_000, 5_000 * 2 ** Math.min(attempts, 10)),
          request.ban_action_id,
        );
      if (attempts === 1 || (attempts & (attempts - 1)) === 0)
        this.logger.warn("Appeal postponed", {
          actionId: request.action_id,
          code: errorCode(error),
          attempts,
        });
      if (attempts === 1 && permanent(error))
        this.notifications.log(
          logNotice(
            `⚠️ Не удалось снять бан **<@${request.user_id}>**; повторим позже.`,
          ),
        );
    } finally {
      this.busy = false;
    }
  }
}
