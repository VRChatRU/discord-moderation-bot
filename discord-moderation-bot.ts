import { fileURLToPath } from "node:url";
import { loadConfig } from "./src/config.ts";
import { createLogger } from "./src/logger.ts";
import { Store } from "./src/store.ts";
import { Bot, createClient } from "./src/bot.ts";

const logger = createLogger(
  fileURLToPath(new URL("./discord-moderation-bot.log", import.meta.url)),
  [Bun.env.DISCORD_TOKEN ?? "", Bun.env.KUMA_PUSH_URL ?? ""],
);
let store: Store | undefined;
let bot: Bot | undefined;
let stopping: Promise<void> | null = null;
function stop(): Promise<void> {
  stopping ??= (async () => {
    try {
      await bot?.stop();
    } finally {
      store?.close();
      await logger.close();
    }
  })();
  return stopping;
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void stop());
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
  process.exitCode = 1;
  void stop();
});
process.on("unhandledRejection", (error) => {
  logger.error("Unhandled rejection", { error });
  process.exitCode = 1;
  void stop();
});
try {
  const config = loadConfig();
  store = new Store(
    fileURLToPath(new URL("./discord-moderation-bot.db", import.meta.url)),
  );
  bot = new Bot(createClient(), store, config, logger);
  await bot.start();
} catch (error) {
  logger.error("Startup failed", { error });
  process.exitCode = 1;
  await stop();
}
