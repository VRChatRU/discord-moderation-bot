import {
  Routes,
  type Client,
  type APIEmbed,
  type APIMessage,
  type RESTGetAPIGuildMessagesSearchResult,
  type RESTPostAPIChannelMessageJSONBody,
} from "discord.js";
import { createHash } from "node:crypto";
import type { Store } from "./store.ts";
import type {
  Action,
  Config,
  Logger,
  OutboxItem,
  Report,
  Sanction,
} from "./types.ts";
import { snapshot } from "./archive.ts";
import {
  actionDm,
  actionLog as actionLogEmbed,
  dmNotice,
  bold,
  userMention,
  dmEmbed,
  logEmbed,
  logNotice,
  reportPayload,
} from "./ui.ts";

export const noMentions = { parse: [] as never[] };
export const errorStatus = (error: unknown): number | undefined =>
  (error as { status?: number } | null)?.status;
export const errorCode = (error: unknown): number | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
};
export const permanent = (error: unknown) => {
  const status = errorStatus(error);
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    ![408, 425, 429].includes(status)
  );
};

function nonce(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

class InvalidNotification extends Error {}

function checkedEmbeds(value: unknown): APIEmbed[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10)
    throw new InvalidNotification("Notification must contain 1–10 embeds");
  let length = 0;
  for (const embed of value as APIEmbed[]) {
    if (!embed || typeof embed !== "object")
      throw new InvalidNotification("Notification contains an invalid embed");
    const count = (content: unknown, limit: number) => {
      if (content === undefined) return;
      if (typeof content !== "string" || content.length > limit)
        throw new InvalidNotification(
          "Notification text exceeds Discord limits",
        );
      length += content.length;
    };
    count(embed.title, 256);
    count(embed.description, 4096);
    count(embed.footer?.text, 2048);
    count(embed.author?.name, 256);
    if (embed.fields !== undefined) {
      if (!Array.isArray(embed.fields) || embed.fields.length > 25)
        throw new InvalidNotification("Notification contains too many fields");
      for (const field of embed.fields) {
        if (!field || !field.name || !field.value)
          throw new InvalidNotification(
            "Notification fields must not be empty",
          );
        count(field.name, 256);
        count(field.value, 1024);
      }
    }
  }
  if (length > 6000)
    throw new InvalidNotification(
      "Notification embeds exceed the combined Discord text limit",
    );
  return value as APIEmbed[];
}

function styledEmbeds(value: unknown, kind: "dm" | "log"): APIEmbed[] {
  return checkedEmbeds(
    checkedEmbeds(value).map(kind === "dm" ? dmEmbed : logEmbed),
  );
}

export class Notifications {
  private busy = false;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  log(embed: { toJSON(): APIEmbed }, id?: string): void {
    this.store.enqueue(
      "log",
      { embeds: styledEmbeds([embed.toJSON()], "log") },
      id,
    );
  }

  actionLog(action: Action, id?: string): void {
    this.store.enqueue(
      "log",
      {
        template: "action-log",
        actionId: action.id,
        actionState: action.state,
      },
      id,
    );
  }

  sanctionEnded(sanction: Sanction, result: string): void {
    this.store.enqueue("log", {
      template: "sanction-ended",
      targetId: sanction.targetId,
      sanctionKind: sanction.kind,
      outcome: /измен|отмен/i.test(result)
        ? "changed"
        : /ещё не истёк/i.test(result)
          ? "not-due"
          : "removed",
    });
  }

  textLog(
    embed: { toJSON(): APIEmbed },
    id?: string,
    evidence?: { name: string; content: string },
    metadata?: Record<string, unknown>,
  ): void {
    this.store.enqueue(
      "log",
      {
        channelId: this.config.textLogChannelId,
        ...metadata,
        embeds: styledEmbeds([embed.toJSON()], "log"),
        ...(evidence ? { evidence } : {}),
      },
      id,
    );
  }

  announce(embed: { toJSON(): APIEmbed }, id?: string): void {
    this.store.enqueue(
      "log",
      {
        channelId: this.config.botChannelId,
        embeds: styledEmbeds([embed.toJSON()], "log"),
      },
      id,
    );
  }

  announceRestart(id?: string): void {
    this.store.enqueue(
      "log",
      {
        channelId: this.config.botChannelId,
        template: "restart",
      },
      id,
    );
  }

  private dmFailure(
    targetId: string,
    actionId: string | null,
    error: unknown,
    notificationId: string,
  ): void {
    const created = this.store.db.transaction(() => {
      const warned = this.store.db
        .query(
          "SELECT 1 FROM audit WHERE event='dm_failed' AND json_extract(data,'$.notificationId')=? LIMIT 1",
        )
        .get(notificationId);
      if (warned) return false;
      this.store.audit("dm_failed", {
        targetId,
        actionId,
        notificationId,
        code: errorCode(error),
        status: errorStatus(error),
      });
      this.store.enqueue(
        "log",
        { template: "dm-failed", targetId, actionId },
        `dm-warning:${notificationId}`,
      );
      return true;
    })();
    if (!created) return;
    this.logger.warn("Direct message could not be delivered", {
      targetId,
      actionId,
      code: errorCode(error),
      status: errorStatus(error),
    });
  }

  queueActionDm(action: Action): boolean {
    if (!action.targetId || action.kind === "purge") return false;
    if (!["scam", "unban"].includes(action.kind) && !action.reason)
      return false;
    const id = `dm:${action.id}`;
    const receipt = this.store.db
      .query(
        "SELECT 1 FROM audit WHERE event='dm_sent' AND json_extract(data,'$.actionId')=? LIMIT 1",
      )
      .get(action.id);
    if (receipt) {
      this.store.completeOutbox(id);
      return false;
    }
    const guild = this.client.guilds.cache.get(this.config.guildId);
    const embeds = styledEmbeds(
      [actionDm(action, guild?.name ?? "VRChatRU", this.config).toJSON()],
      "dm",
    );
    // Persist first: a crash before or during Discord's response must leave a retryable notification.
    this.store.enqueue(
      "dm",
      { targetId: action.targetId, embeds, actionId: action.id },
      id,
    );
    return true;
  }

  async actionDm(action: Action): Promise<boolean> {
    if (!action.targetId || !this.queueActionDm(action)) return false;
    const guild = this.client.guilds.cache.get(this.config.guildId);
    const id = `dm:${action.id}`;
    const embeds = styledEmbeds(
      [actionDm(action, guild?.name ?? "VRChatRU", this.config).toJSON()],
      "dm",
    );
    this.inFlight.add(id);
    try {
      const user = await this.client.users.fetch(action.targetId);
      await user.send({
        embeds,
        allowedMentions: noMentions,
        nonce: nonce(id),
        enforceNonce: true,
      });
      this.store.completeOutbox(id);
      this.store.audit("dm_sent", {
        targetId: action.targetId,
        actionId: action.id,
      });
      this.logger.info("Direct message delivered", {
        targetId: action.targetId,
        actionId: action.id,
      });
      return true;
    } catch (error) {
      this.dmFailure(action.targetId, action.id, error, id);
      // Network errors can recover; closed DMs cannot. A retry is independent of moderation.
      if (permanent(error)) this.store.completeOutbox(id);
      else
        this.store.retryOutbox(
          id,
          String(errorCode(error) ?? errorStatus(error) ?? "network"),
        );
      return false;
    } finally {
      this.inFlight.delete(id);
    }
  }

  async tick(): Promise<void> {
    if (this.busy || !this.client.isReady()) return;
    this.busy = true;
    try {
      for (const item of this.store.dueOutbox(Date.now(), 5)) {
        if (this.inFlight.has(item.id)) continue;
        try {
          await this.deliver(item);
          this.store.completeOutbox(item.id);
        } catch (error) {
          if (error instanceof InvalidNotification) {
            this.store.audit("notification_invalid", {
              id: item.id,
              kind: item.kind,
              reason: error.message,
              payload: item.payload,
            });
            this.logger.error("Invalid notification discarded", {
              id: item.id,
              kind: item.kind,
              error,
            });
            this.store.completeOutbox(item.id);
            continue;
          }
          if (item.kind === "dm") {
            this.dmFailure(
              String(item.payload.targetId),
              typeof item.payload.actionId === "string"
                ? item.payload.actionId
                : null,
              error,
              item.id,
            );
            if (permanent(error)) {
              this.store.completeOutbox(item.id);
              continue;
            }
          }
          this.store.retryOutbox(
            item.id,
            String(errorCode(error) ?? errorStatus(error) ?? "network"),
          );
          if (
            item.attempts === 0 ||
            (item.attempts & (item.attempts - 1)) === 0
          )
            this.logger.warn("Notification delivery postponed", {
              id: item.id,
              kind: item.kind,
              attempts: item.attempts + 1,
              code: errorCode(error),
              status: errorStatus(error),
            });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private rendered(item: OutboxItem, kind: "dm" | "log"): APIEmbed[] | null {
    const p = item.payload;
    if (p.template === "action-log" && typeof p.actionId === "string") {
      const action = this.store.getAction(p.actionId);
      return action
        ? [
            actionLogEmbed({
              ...action,
              state: (p.actionState ?? action.state) as Action["state"],
            }).toJSON(),
          ]
        : null;
    }
    if (kind === "dm" && p.template === "unban")
      return [
        dmNotice(
          `Бан снят. ${bold(`[Вернуться на сервер](${this.config.inviteUrl})`)}`,
        ).toJSON(),
      ];
    if (kind === "dm" && p.template === "action-cancelled")
      return [
        dmNotice(
          "Предыдущее уведомление отменено: действие не выполнено.",
        ).toJSON(),
      ];
    if (kind === "dm" && typeof p.actionId === "string") {
      const action = this.store.getAction(p.actionId);
      if (action) return [actionDm(action, "", this.config).toJSON()];
    }
    if (p.template === "dm-failed" && typeof p.targetId === "string")
      return [
        logNotice(
          `⚠️ Не удалось отправить ЛС ${userMention(p.targetId)}.`,
        ).toJSON(),
      ];
    if (p.template === "sanction-ended" && typeof p.targetId === "string") {
      const user = userMention(p.targetId);
      const message =
        p.outcome === "changed"
          ? `Снятие наказания ${user} отменено: наказание изменено.`
          : p.outcome === "not-due"
            ? `Срок наказания ${user} ещё не истёк.`
            : `С ${user} снят ${bold(p.sanctionKind === "ban" ? "бан" : "мьют")}: срок истёк.`;
      return [logNotice(message).toJSON()];
    }
    if (p.embeds !== undefined) return styledEmbeds(p.embeds, kind);
    if (p.template === "text-log") {
      const user =
        typeof p.targetId === "string" ? `${userMention(p.targetId)} ` : "";
      if (p.outcome === "member-left")
        return [logNotice(`${user}покинул сервер.`).toJSON()];
      const channel =
        typeof p.sourceChannelId === "string"
          ? ` в ${bold(`<#${p.sourceChannelId}>`)}`
          : "";
      const link =
        typeof p.messageId === "string" && typeof p.sourceChannelId === "string"
          ? `\n[**${p.messageId}**](https://discord.com/channels/${this.config.guildId}/${p.sourceChannelId}/${p.messageId})`
          : "";
      const event =
        p.outcome === "bulk"
          ? `Удалено ${bold(String(p.count ?? 0))} сообщений`
          : p.outcome === "edited"
            ? "Сообщение изменено"
            : p.outcome === "edit-unavailable"
              ? "Обновление сообщения"
              : "Сообщение удалено";
      return [
        logNotice(
          `${user}${event}${channel}.${link}\nТекст недоступен после перезапуска.`,
        ).toJSON(),
      ];
    }
    this.logger.warn("Transient notification content is no longer available", {
      id: item.id,
      kind: item.kind,
    });
    return null;
  }

  private async reportForDelivery(report: Report): Promise<Report> {
    if (this.store.hasReportEvidence(report.id)) return report;
    let message = report.message;
    try {
      const raw = (await this.client.rest.get(
        Routes.channelMessage(report.channelId, report.messageId),
      )) as APIMessage;
      if (raw.author && typeof raw.content === "string")
        message = snapshot(raw);
    } catch (error) {
      if (!permanent(error)) throw error;
    }
    let context = report.context;
    try {
      const query = new URLSearchParams({
        author_id: report.targetId,
        limit: "10",
        sort_by: "timestamp",
        sort_order: "desc",
        include_nsfw: "true",
      });
      const maxId =
        (BigInt(Math.max(0, report.createdAt - 1_420_070_400_000)) << 22n) +
        4_194_303n;
      query.set("max_id", maxId.toString());
      const data = (await this.client.rest.get(
        Routes.guildMessagesSearch(report.guildId),
        { query },
      )) as RESTGetAPIGuildMessagesSearchResult;
      if (!("messages" in data))
        throw new Error("Guild message search is not indexed yet");
      const unique = new Map(
        data.messages
          .flat()
          .filter((item) => item.author.id === report.targetId)
          .map((item) => [item.id, snapshot(item)]),
      );
      context = [...unique.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10);
    } catch (error) {
      if (!permanent(error)) throw error;
    }
    const hydrated = {
      ...report,
      message,
      context,
      contextWarning: context.length
        ? undefined
        : "История недоступна; сообщения не сохраняются в базе.",
    };
    this.store.cacheReportEvidence(hydrated);
    return hydrated;
  }

  private async deliver(item: OutboxItem): Promise<void> {
    if (item.kind === "dm") {
      const actionId =
        typeof item.payload.actionId === "string"
          ? item.payload.actionId
          : null;
      const action = actionId ? this.store.getAction(actionId) : null;
      const unbanNotice =
        item.payload.template === "unban" || action?.kind === "unban";
      const correction = item.payload.template === "action-cancelled";
      // A delayed notice must not describe a sanction that has ended or been replaced.
      if (!correction) {
        const targetId = action?.targetId ?? String(item.payload.targetId);
        let obsolete =
          unbanNotice &&
          !!this.store.getSanction(this.config.guildId, targetId, "ban");
        if (
          !unbanNotice &&
          action?.state === "succeeded" &&
          ["mute", "ban", "kill", "scam"].includes(action.kind)
        ) {
          const sanction = this.store.getSanction(
            action.guildId,
            targetId,
            action.kind === "mute" ? "mute" : "ban",
          );
          obsolete ||= sanction?.actionId !== action.id;
        }
        if (obsolete) {
          this.logger.info("Obsolete direct message skipped", {
            id: item.id,
            actionId,
          });
          return;
        }
      }
      if (
        action &&
        !["unban", "action-cancelled"].includes(
          String(item.payload.template),
        ) &&
        ["failed", "cancelled", "expired"].includes(action.state)
      ) {
        this.store.audit("dm_skipped", {
          id: item.id,
          actionId,
          state: action.state,
        });
        return;
      }
      const embeds = this.rendered(item, "dm");
      if (!embeds) return;
      const user = await this.client.users.fetch(String(item.payload.targetId));
      await user.send({
        embeds,
        allowedMentions: noMentions,
        nonce: nonce(item.id),
        enforceNonce: true,
      });
      this.store.audit("dm_sent", {
        targetId: user.id,
        actionId: item.payload.actionId ?? null,
        retry: true,
      });
      this.logger.info("Direct message delivered", {
        targetId: user.id,
        actionId: item.payload.actionId ?? null,
        retry: true,
      });
      return;
    }
    let body: RESTPostAPIChannelMessageJSONBody;
    let files:
      Array<{ name: string; data: Buffer; contentType: string }> | undefined;
    if (item.kind === "log" && item.payload.template === "restart") {
      body = { content: "vrcru-discord-moderation-bot перезагружен" };
    } else if (item.kind === "log") {
      const embeds = this.rendered(item, "log");
      if (!embeds) return;
      body = { embeds };
      if (item.payload.evidence !== undefined) {
        const evidence = item.payload.evidence as {
          name?: unknown;
          content?: unknown;
        } | null;
        if (
          item.payload.channelId !== this.config.textLogChannelId ||
          !evidence ||
          typeof evidence.name !== "string" ||
          !/^[a-zA-Z0-9._-]{1,128}\.txt$/.test(evidence.name) ||
          typeof evidence.content !== "string" ||
          Buffer.byteLength(evidence.content, "utf8") > 8_000_000
        ) {
          throw new InvalidNotification("Invalid text-log evidence file");
        }
        files = [
          {
            name: evidence.name,
            data: Buffer.from(evidence.content, "utf8"),
            contentType: "text/plain; charset=utf-8",
          },
        ];
        body.attachments = [{ id: "0", filename: evidence.name }];
      }
    } else {
      let report = this.store.getReport(String(item.payload.reportId));
      if (!report) return;
      if (
        item.kind === "report" &&
        report.modMessageId &&
        report.modMessageId !== item.payload.replacingMessageId
      )
        return;
      if (item.kind === "report") report = await this.reportForDelivery(report);
      const rendered = reportPayload(report);
      body = {
        embeds: checkedEmbeds(rendered.embeds.map((embed) => embed.toJSON())),
        components: rendered.components.map((row) => row.toJSON()),
        attachments: [],
        ...(this.config.moderatorRoleIds[0]
          ? { content: `**<@&${this.config.moderatorRoleIds[0]}>**` }
          : {}),
      };
      checkedEmbeds(body.embeds);
      if (item.kind === "report-edit") {
        if (!report.modMessageId) return; // The durable report send renders its latest state.
        try {
          if (!this.store.hasReportEvidence(report.id)) {
            const existing = (await this.client.rest.get(
              Routes.channelMessage(
                this.config.modLogChannelId,
                report.modMessageId,
              ),
            )) as { embeds?: APIEmbed[] };
            if (existing.embeds?.length) {
              const latest = body.embeds![0]!;
              body.embeds = checkedEmbeds(
                existing.embeds.map((embed, index) =>
                  index
                    ? embed
                    : {
                        ...embed,
                        fields: [
                          ...(embed.fields ?? []).filter(
                            (field) =>
                              !["Решение:", "Статус:"].includes(field.name),
                          ),
                          ...(latest.fields ?? []).filter((field) =>
                            ["Решение:", "Статус:"].includes(field.name),
                          ),
                        ],
                      },
                ),
              );
            }
          }
          await this.client.rest.patch(
            Routes.channelMessage(
              this.config.modLogChannelId,
              report.modMessageId,
            ),
            { body: { ...body, allowed_mentions: noMentions } },
          );
        } catch (error) {
          if (errorCode(error) === 10008) {
            this.store.enqueue(
              "report",
              { reportId: report.id, replacingMessageId: report.modMessageId },
              `report-replacement:${report.id}:${report.modMessageId}`,
            );
            return;
          }
          throw error;
        }
        this.store.audit("notification_delivered", {
          id: item.id,
          kind: item.kind,
          messageId: report.modMessageId,
          channelId: this.config.modLogChannelId,
        });
        this.logger.info("Report message updated", {
          id: item.id,
          reportId: report.id,
          messageId: report.modMessageId,
        });
        this.store.clearReportEvidence(report.id);
        return;
      }
      // A replacement may supersede only the deleted message it was created for.
      if (
        report.modMessageId &&
        report.modMessageId !== item.payload.replacingMessageId
      )
        return;
    }
    if (body.embeds) checkedEmbeds(body.embeds);
    const channelId =
      item.kind === "log" &&
      (item.payload.channelId === this.config.botChannelId ||
        item.payload.channelId === this.config.textLogChannelId)
        ? String(item.payload.channelId)
        : this.config.modLogChannelId;
    const moderatorRoleId =
      item.kind === "report" && !item.payload.replacingMessageId
        ? this.config.moderatorRoleIds[0]
        : undefined;
    const message = (await this.client.rest.post(
      Routes.channelMessages(channelId),
      {
        body: {
          ...body,
          allowed_mentions: moderatorRoleId
            ? { parse: [], roles: [moderatorRoleId] }
            : noMentions,
          nonce: nonce(item.id),
          enforce_nonce: true,
        },
        files,
      },
    )) as { id: string };
    if (item.kind === "report") {
      this.store.setReportMessage(String(item.payload.reportId), message.id);
      this.store.clearReportEvidence(String(item.payload.reportId));
    }
    this.store.audit("notification_delivered", {
      id: item.id,
      kind: item.kind,
      messageId: message.id,
      channelId,
    });
    this.logger.info("Notification delivered", {
      id: item.id,
      kind: item.kind,
      messageId: message.id,
      channelId,
    });
  }
}
