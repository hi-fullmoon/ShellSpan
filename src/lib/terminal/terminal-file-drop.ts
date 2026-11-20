export function quoteTerminalDropPaths(paths: readonly string[], powerShell: boolean): string | null {
  if (!paths.length || paths.some((path) => !path || /[\u0000-\u001f\u007f-\u009f]/.test(path))) return null;
  return paths.map((path) => {
    const escaped = powerShell
      ? path.replace(/['‘’‚‛]/g, (quote) => quote + quote)
      : path.replace(/'/g, "'\\''");
    return "'" + escaped + "'";
  }).join(' ');
}
