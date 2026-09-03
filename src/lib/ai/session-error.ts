import type { AiSessionError } from './session-adapter';

/** Convert Agent Runtime, Tauri, and transport failures into one recoverable UI error. */
export function normalizeAiSessionError(error: unknown): AiSessionError {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : JSON.stringify(error);
  const text = message.toLowerCase();
  const revision = /current revision\s+(\d+)/i.exec(message);
  if (/unauthori[sz]ed|forbidden|api key|authentication|401|403/.test(text)) {
    return { kind: 'auth', message, retryable: true };
  }
  if (/rate.?limit|too many requests|429/.test(text)) {
    return { kind: 'rateLimit', message, retryable: true };
  }
  if (/offline|network|connection|disconnected|unreachable/.test(text)) {
    return { kind: 'offline', message, retryable: true };
  }
  if (/conflict|already|in progress|busy|409/.test(text)) {
    return {
      kind: 'conflict',
      message,
      retryable: true,
      ...(revision ? { currentRevision: Number(revision[1]) } : {}),
    };
  }
  if (/cancelled|canceled|abort/.test(text)) {
    return { kind: 'cancelled', message, retryable: false };
  }
  if (/terminal|ended|completed session|closed session/.test(text)) {
    return { kind: 'terminal', message, retryable: false };
  }
  return { kind: 'unknown', message, retryable: true };
}
