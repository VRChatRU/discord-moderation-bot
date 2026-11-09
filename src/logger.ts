import { closeSync, openSync } from "node:fs";
import type { Logger } from "./types.ts";

export function createLogger(
  path = "discord-moderation-bot.log",
  secrets: string[] = [],
): Logger {
  // Bun path writers begin at offset zero; an append descriptor preserves earlier runs.
  const fd = openSync(path, "a", 0o600);
  let writer: ReturnType<Bun.BunFile["writer"]>;
  try {
    writer = Bun.file(fd).writer({ highWaterMark: 1 });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const privateValues = [...new Set(secrets.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  let failed = false;
  let closed = false;
  const failedWrite = () => {
    if (!failed) console.error("Could not write application log");
    failed = true;
  };
  const redact = (value: string): string => {
    for (const secret of privateValues)
      value = value.split(secret).join("[REDACTED]");
    return value.replace(/Bot\s+[A-Za-z0-9._-]+/g, "Bot [REDACTED]");
  };
  function write(
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (closed) return;
    try {
      const seen = new WeakSet<object>();
      const line = JSON.stringify(
        { time: new Date().toISOString(), level, message, data },
        (key, value: unknown) => {
          if (
            /^(token|authorization|password|secret|kumaUrl|kumaPushUrl)$/i.test(
              key,
            )
          )
            return "[REDACTED]";
          if (value instanceof Error) {
            const error = value as Error & { code?: unknown; status?: unknown };
            return {
              name: error.name,
              message: redact(error.message),
              code: error.code,
              status: error.status,
            };
          }
          if (typeof value === "string") return redact(value);
          if (typeof value === "bigint") return value.toString();
          if (typeof value === "object" && value !== null) {
            if (seen.has(value)) return "[Circular]";
            seen.add(value);
          }
          return value;
        },
      );
      console[level === "info" ? "log" : level](line);
      writer.write(`${line}\n`);
      const flush = writer.flush();
      if (flush instanceof Promise) void flush.catch(failedWrite);
    } catch {
      failedWrite();
    }
  }
  return {
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
    async close() {
      if (closed) return;
      closed = true;
      try {
        await writer.end();
      } catch {
        failedWrite();
      } finally {
        try {
          closeSync(fd);
        } catch {
          failedWrite();
        }
      }
    },
  };
}
