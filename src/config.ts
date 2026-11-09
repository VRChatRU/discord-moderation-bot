import type { Config } from "./types.ts";

const snowflake = /^[1-9]\d{16,19}$/;

function id(value: string, name: string): string {
  if (!snowflake.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new Error(`${name} must be a Discord snowflake ID`);
  }
  return value;
}

export function loadConfig(
  env: Record<string, string | undefined> = Bun.env,
): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value)
      throw new Error(`${name} is required; configure .env using example.env`);
    return value;
  };
  const kumaUrl = required("KUMA_PUSH_URL");
  try {
    const parsed = new URL(kumaUrl);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error("Invalid URL");
    }
  } catch {
    throw new Error(
      "KUMA_PUSH_URL must be an HTTP(S) push URL without credentials or a fragment",
    );
  }
  const inviteUrl = required("SERVER_INVITE_URL");
  try {
    const invite = new URL(inviteUrl);
    if (
      invite.protocol !== "https:" ||
      !invite.hostname ||
      invite.username ||
      invite.password ||
      invite.hash
    ) {
      throw new Error("Invalid invite");
    }
  } catch {
    throw new Error(
      "SERVER_INVITE_URL must be an HTTPS invitation URL without credentials or a fragment",
    );
  }
  const hours = Number(env.SCAM_APPEAL_HOURS?.trim() || "336");
  if (!Number.isFinite(hours) || hours < 0 || hours > 876_000) {
    throw new Error("SCAM_APPEAL_HOURS must be between 0 and 876000");
  }
  const context = env.REPORT_CONTEXT?.trim() || "guild";
  if (context !== "author" && context !== "channel" && context !== "guild") {
    throw new Error("REPORT_CONTEXT must be author, channel or guild");
  }
  const fullHistory = env.KILL_FULL_HISTORY?.trim().toLowerCase() || "false";
  if (fullHistory !== "false")
    throw new Error(
      "KILL_FULL_HISTORY is unsupported; /kill deletes messages from the last 7 days",
    );
  const rules = new Map<number, string>();
  for (let number = 1; number <= 11; number++) {
    const rule = env[`RULE_${number}`]?.trim();
    if (!rule) continue;
    if (rule.length > 950)
      throw new Error(`RULE_${number} must contain at most 950 characters`);
    rules.set(number, rule);
  }
  return {
    token: required("DISCORD_TOKEN"),
    guildId: id(required("GUILD_ID"), "GUILD_ID"),
    muteRoleId: id(required("MUTE_ROLE_ID"), "MUTE_ROLE_ID"),
    modLogChannelId: id(
      env.MOD_LOG_CHANNEL_ID?.trim() || "801483885132513280",
      "MOD_LOG_CHANNEL_ID",
    ),
    textLogChannelId: id(
      env.TEXT_LOG_CHANNEL_ID?.trim() || "760706717188489226",
      "TEXT_LOG_CHANNEL_ID",
    ),
    botChannelId: id(
      env.BOT_CHANNEL_ID?.trim() || "764477131345362956",
      "BOT_CHANNEL_ID",
    ),
    inviteUrl,
    moderatorRoleIds: [
      ...new Set(
        (env.MODERATOR_ROLE_IDS?.trim() || "").split(/[\s,]+/).filter(Boolean),
      ),
    ].map((role) => id(role, "MODERATOR_ROLE_IDS")),
    kumaUrl,
    rules,
    previewThreadId: id(
      env.PREVIEW_THREAD_ID?.trim() || "1568864293712171018",
      "PREVIEW_THREAD_ID",
    ),
    scamAppealHours: hours,
    reportContext: context,
    killHistory: false,
  };
}

export function resolveReason(
  raw: string | null,
  rules: Map<number, string>,
): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value.length > 1000)
    throw new Error("Причина должна содержать не более 1000 символов.");
  const match = /^(?:RULE[_\s-]?|#)?(\d+)$/i.exec(value);
  if (!match) return value;
  const number = Number(match[1]);
  if (number < 1 || number > 11 || !rules.has(number)) {
    throw new Error(
      "Это правило не настроено. Укажите причину текстом или номер настроенного правила от 1 до 11.",
    );
  }
  return `Правило ${number}. ${rules.get(number)}`;
}
