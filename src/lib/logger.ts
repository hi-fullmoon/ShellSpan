import {
  debug as tauriDebug,
  error as tauriError,
  info as tauriInfo,
  warn as tauriWarn,
} from "@tauri-apps/plugin-log";
import type { LogLevel } from '../types';
import { isTauriRuntime } from "./tauri";

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

function formatMessage(scope: string, message: string, details?: unknown) {
  const detailsText = toDetailsString(details);
  if (!detailsText) {
    return `[${scope}] ${message}`;
  }

  return `[${scope}] ${message} ${detailsText}`;
}

function printToConsole(level: LogLevel, scope: string, message: string, details?: unknown) {
  const tag = `[termbridge][${level.toUpperCase()}][${scope}]`;
  const text = `${tag} ${message}`;
  const method =
    level === "debug"
      ? console.debug
      : level === "info"
        ? console.info
        : level === "warn"
          ? console.warn
          : console.error;

  if (details === undefined) {
    method(text);
    return;
  }

  method(text, details);
}

async function writeToTauri(level: LogLevel, message: string) {
  switch (level) {
    case "debug":
      await tauriDebug(message);
      return;
    case "info":
      await tauriInfo(message);
      return;
    case "warn":
      await tauriWarn(message);
      return;
    case "error":
      await tauriError(message);
      return;
  }
}

function log(level: LogLevel, scope: string, message: string, details?: unknown) {
  if (!shouldLog(level)) {
    return;
  }

  const formattedMessage = formatMessage(scope, message, details);
  if (!isTauriRuntime()) {
    printToConsole(level, scope, message, details);
    return;
  }

  void writeToTauri(level, formattedMessage).catch((error) => {
    printToConsole(level, scope, message, details);
    console.error("[termbridge][ERROR][logger] Failed to write desktop log", error);
  });
}
