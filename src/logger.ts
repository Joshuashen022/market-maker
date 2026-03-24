import fs from "node:fs";
import path from "node:path";
import util from "node:util";

export type Log = Pick<Console, "log" | "info" | "warn" | "error">;

type FileLogger = Log & {
  filePath: string;
  close: () => Promise<void>;
};

function formatUtcPlus8(date: Date, forFileName = false): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const iso = shifted.toISOString();
  return forFileName ? iso.replace(/[:.]/g, "-") : iso.replace("Z", "+08:00");
}

export function createFileLogger(prefix: string): FileLogger {
  const logsDir = path.resolve(process.cwd(), "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const startedAt = formatUtcPlus8(new Date(), true);
  const filePath = path.join(logsDir, `${prefix}-${startedAt}.log`);
  const stream = fs.createWriteStream(filePath, { flags: "a" });

  const write = (level: string, args: unknown[]) => {
    const timestamp = formatUtcPlus8(new Date());
    stream.write(`[${timestamp}] [${level}] ${util.format(...args)}\n`);
  };

  return {
    filePath,
    log: (...args: unknown[]) => {
      write("LOG", args);
      console.log(...args);
    },
    info: (...args: unknown[]) => {
      write("INFO", args);
      console.info(...args);
    },
    warn: (...args: unknown[]) => {
      write("WARN", args);
      console.warn(...args);
    },
    error: (...args: unknown[]) => {
      write("ERROR", args);
      console.error(...args);
    },
    close: () =>
      new Promise<void>((resolve) => {
        stream.end(resolve);
      }),
  };
}
