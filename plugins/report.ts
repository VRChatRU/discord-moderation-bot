import type { Message } from "discord.js";
import type { MessageSnapshot } from "../src/types.ts";

export function snapshotMessage(message: Message): MessageSnapshot {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.author.tag,
    content: message.content,
    attachments: [...message.attachments.values()].map(
      (attachment) => attachment.url,
    ),
    createdAt: message.createdTimestamp,
  };
}

export default { name: "report", snapshotMessage };
