type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

// Kept in sync with isTauriRuntime() in '@/lib/tauri'. Duplicated on purpose:
// the logger must stay dependency-free because '@/lib/tauri' is frequently
// vi.mock'ed in tests, and tauri.ts itself imports this module.
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function serializeDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return detail.stack ?? detail.message;
  }
  if (typeof detail === 'string') {
    return detail;
  }
  try {
    return JSON.stringify(detail) ?? String(detail);
  } catch {
    return String(detail);
  }
}

function formatRecord(module: string, message: string, details: unknown[]): string {
  const base = `[${module}] ${message}`;
  if (details.length === 0) {
    return base;
  }
  return `${base} ${details.map(serializeDetail).join(' ')}`;
}

async function writeToTauriLog(level: LogLevel, record: string): Promise<void> {
  try {
    const plugin = await import('@tauri-apps/plugin-log');
    await plugin[level](record);
  } catch {
    // Logging must never throw.
  }
}

export function createLogger(module: string): Logger {
  const write = (level: LogLevel, message: string, details: unknown[]): void => {
    try {
      const record = formatRecord(module, message, details);
      if (isTauriRuntime()) {
        void writeToTauriLog(level, record);
        return;
      }
      console[level](record);
    } catch {
      // Logging must never throw.
    }
  };

  return {
    debug: (message, ...details) => write('debug', message, details),
    info: (message, ...details) => write('info', message, details),
    warn: (message, ...details) => write('warn', message, details),
    error: (message, ...details) => write('error', message, details),
  };
}

export function initGlobalErrorLogging(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const logger = createLogger('global');
  window.addEventListener('error', (event) => {
    logger.error('Unhandled error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    logger.error('Unhandled promise rejection', event.reason);
  });
}
