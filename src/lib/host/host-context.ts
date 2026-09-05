/**
 * Builds the explicit shell command used by “Open terminal here”. The path is
 * wrapped as one POSIX-shell argument and control characters are rejected so
 * a remote filename cannot become a second command.
 */
export function buildChangeDirectoryCommand(path: string): string | undefined {
  if (!path || /[\0\r\n]/.test(path)) return undefined;
  const escapedPath = path.replace(/'/g, `'\\''`);
  return `cd -- '${escapedPath}'\r`;
}
