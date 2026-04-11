import { useLogStore } from "../stores/logStore";
import type { LogEntry, LogLevel } from "../types";

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LOG_LEVEL_STORAGE_KEY = "termbridge.logLevel";
const DEFAULT_LOG_LEVEL: LogLevel = import.meta.env.DEV ? "debug" : "info";

let minimumLevel: LogLevel = readMinimumLevel();

export interface Logger {
  debug: (message: string, details?: unknown) => void;
  info: (message: string, details?: unknown) => void;
  warn: (message: string, details?: unknown) => void;
  error: (message: string, details?: unknown) => void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, details) => log("debug", scope, message, details),
    info: (message, details) => log("info", scope, message, details),
    warn: (message, details) => log("warn", scope, message, details),
    error: (message, details) => log("error", scope, message, details),
  };
}

export function getLogLevel(): LogLevel {
  return minimumLevel;
}

export function setLogLevel(level: LogLevel) {
  minimumLevel = level;

  try {
    window.localStorage.setItem(LOG_LEVEL_STORAGE_KEY, level);
  } catch {
    // Ignore storage write failures.
  }
}

function readMinimumLevel(): LogLevel {
  try {
    const raw = window.localStorage.getItem(LOG_LEVEL_STORAGE_KEY);
    if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
      return raw;
    }
  } catch {
    // Ignore storage read failures.
  }

  return DEFAULT_LOG_LEVEL;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[minimumLevel];
}

function toDetailsString(details: unknown): string | undefined {
  if (details === undefined) {
    return undefined;
  }

  if (typeof details === "string") {
    return details;
  }

  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function createEntry(level: LogLevel, scope: string, message: string, details?: unknown): LogEntry {
  const timestamp = Date.now();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${timestamp}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    id,
    timestamp,
    level,
    scope,
    message,
    details: toDetailsString(details),
  };
}

function printToConsole(entry: LogEntry, details?: unknown) {
  const tag = `[termbridge][${entry.level.toUpperCase()}][${entry.scope}]`;
  const text = `${tag} ${entry.message}`;
  const method =
    entry.level === "debug"
      ? console.debug
      : entry.level === "info"
        ? console.info
        : entry.level === "warn"
          ? console.warn
          : console.error;

  if (details === undefined) {
    method(text);
    return;
  }

  method(text, details);
}

function log(level: LogLevel, scope: string, message: string, details?: unknown) {
  if (!shouldLog(level)) {
    return;
  }

  const entry = createEntry(level, scope, message, details);
  useLogStore.getState().append(entry);
  printToConsole(entry, details);
}
