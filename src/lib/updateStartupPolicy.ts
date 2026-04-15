const STARTUP_UPDATE_CHECK_KEY = "termbridge.update.startupLastCheckAt";
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export function shouldRunStartupUpdateCheck(now: number): boolean {
  const raw = window.localStorage.getItem(STARTUP_UPDATE_CHECK_KEY);

  if (raw == null) {
    return true;
  }

  const lastCheckAt = Number(raw);
  if (!Number.isFinite(lastCheckAt)) {
    return true;
  }

  return now - lastCheckAt >= TWELVE_HOURS_MS;
}

export function markStartupUpdateCheck(now: number): void {
  window.localStorage.setItem(STARTUP_UPDATE_CHECK_KEY, String(now));
}
