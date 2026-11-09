import mute from "./mute.ts";
import kill from "./kill.ts";
import kick from "./kick.ts";
import ban from "./ban.ts";
import unban from "./unban.ts";
import warn from "./warn.ts";
import purge from "./purge.ts";
import scam from "./scam.ts";
import type { ModerationPlugin } from "../src/moderation.ts";
import type { ActionKind } from "../src/types.ts";

export const moderationPlugins: Record<ActionKind, ModerationPlugin> = {
  mute,
  kill,
  kick,
  ban,
  unban,
  warn,
  purge,
  scam,
};
export { default as modlogs } from "./modlogs.ts";
export { default as report } from "./report.ts";
