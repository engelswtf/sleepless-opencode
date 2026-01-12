import { writeFileSync, appendFileSync, existsSync, renameSync, statSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LoggerConfig {
  level: LogLevel;
  json: boolean;
  file?: string;
  maxSizeBytes?: number;
  maxFiles?: number;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";

export class Logger {
  private config: LoggerConfig;
  private component: string;

  constructor(component: string, config?: Partial<LoggerConfig>) {
    this.component = component;
    this.config = {
      level: (process.env.LOG_LEVEL as LogLevel) || "info",
      json: process.env.LOG_FORMAT === "json",
      file: process.env.LOG_FILE,
      maxSizeBytes: parseInt(process.env.LOG_MAX_SIZE || "10485760", 10),
      maxFiles: parseInt(process.env.LOG_MAX_FILES || "5", 10),
      ...config,
    };

    if (this.config.file) {
      const dir = dirname(this.config.file);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  child(component: string): Logger {
    return new Logger(`${this.component}:${component}`, this.config);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.config.level]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...(data && Object.keys(data).length > 0 && { data }),
    };

    if (this.config.json) {
      this.outputJson(entry);
    } else {
      this.outputPretty(entry);
    }

    if (this.config.file) {
      this.writeToFile(entry);
    }
  }

  private outputJson(entry: LogEntry): void {
    const output = entry.level === "error" ? console.error : console.log;
    output(JSON.stringify(entry));
  }

  private outputPretty(entry: LogEntry): void {
    const color = LEVEL_COLORS[entry.level];
    const levelStr = entry.level.toUpperCase().padEnd(5);
    const time = entry.timestamp.split("T")[1].split(".")[0];
    
    let line = `${color}[${time}] ${levelStr}${RESET} [${entry.component}] ${entry.message}`;
    
    if (entry.data) {
      line += ` ${JSON.stringify(entry.data)}`;
    }

    if (entry.level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  private writeToFile(entry: LogEntry): void {
    if (!this.config.file) return;

    this.rotateIfNeeded();
    
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(this.config.file, line);
  }

  private rotateIfNeeded(): void {
    if (!this.config.file || !existsSync(this.config.file)) return;

    try {
      const stats = statSync(this.config.file);
      if (stats.size < (this.config.maxSizeBytes || 10 * 1024 * 1024)) return;

      for (let i = (this.config.maxFiles || 5) - 1; i >= 1; i--) {
        const oldPath = `${this.config.file}.${i}`;
        const newPath = `${this.config.file}.${i + 1}`;
        if (existsSync(oldPath)) {
          renameSync(oldPath, newPath);
        }
      }

      renameSync(this.config.file, `${this.config.file}.1`);
    } catch (err) {
      console.error("[logger] Failed to rotate log file:", err);
    }
  }
}

let defaultLogger: Logger | null = null;

export function getLogger(component: string): Logger {
  if (!defaultLogger) {
    defaultLogger = new Logger("sleepless");
  }
  return defaultLogger.child(component);
}

export function setLogConfig(config: Partial<LoggerConfig>): void {
  defaultLogger = new Logger("sleepless", config);
}
