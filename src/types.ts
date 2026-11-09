export const actionKinds = [
  "mute",
  "kill",
  "kick",
  "ban",
  "unban",
  "warn",
  "purge",
  "scam",
] as const;
export const scamAppealPhrase =
  "Я избавился от вирусов и поменял пароль в Discord, пустите меня обратно";
export type ActionKind = (typeof actionKinds)[number];
export type ActionState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "uncertain";

export interface ActionInput {
  id: string;
  interactionId: string;
  guildId: string;
  actorId: string;
  targetId: string | null;
  channelId: string;
  kind: ActionKind;
  reason: string | null;
  durationDays: number | null;
  count: number | null;
  reportId: string | null;
  createdAt: number;
  confirmUntil: number;
  messageIds: string[];
}

export interface Action extends ActionInput {
  state: ActionState;
  result: string | null;
  completedAt: number | null;
}

export interface Sanction {
  guildId: string;
  targetId: string;
  kind: "mute" | "ban";
  actionId: string;
  expiresAt: number | null;
  roleId: string | null;
}

export interface ReportInput {
  id: string;
  interactionId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  targetId: string;
  reporterId: string;
  reason: string | null;
  message: MessageSnapshot;
  context: MessageSnapshot[];
  contextWarning?: string;
  targetAvatarUrl?: string;
  reporterName?: string;
  createdAt: number;
}

export interface Report extends ReportInput {
  state: "open" | "processing" | "resolved";
  modMessageId: string | null;
  resolvedBy: string | null;
  resolution: string | null;
}

export interface MessageSnapshot {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  attachments: string[];
  createdAt: number;
}

export interface OutboxItem {
  id: string;
  kind: "log" | "dm" | "report" | "report-edit";
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: number;
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  close(): Promise<void>;
}

export interface Config {
  token: string;
  guildId: string;
  muteRoleId: string;
  modLogChannelId: string;
  textLogChannelId: string;
  botChannelId: string;
  inviteUrl: string;
  moderatorRoleIds: string[];
  kumaUrl: string;
  rules: Map<number, string>;
  previewThreadId: string;
  scamAppealHours: number;
  reportContext: "author" | "channel" | "guild";
  killHistory: boolean;
}
