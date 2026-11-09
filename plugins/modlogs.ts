import type { Store } from "../src/store.ts";

export default {
  name: "modlogs",
  page(store: Store, guildId: string, targetId: string, page = 0) {
    if (!Number.isSafeInteger(page) || page < 0)
      throw new Error("Invalid history page");
    return store.listActions(targetId, guildId, 10, page * 10);
  },
};
