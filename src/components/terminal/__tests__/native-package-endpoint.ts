export function nativePackageEndpoint(path: string, href = location.href): string {
  if (!/^\/(?:__agent-stream-result|__native-file-witness|__package-capture)\/[a-f0-9-]{36}$/.test(path)) throw new Error('Invalid native acceptance endpoint');
  const origin = new URL(href).searchParams.get('reportOrigin');
  if (!origin) return path;
  const parsed = new URL(origin);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid owned package report origin');
  return parsed.origin + path;
}
