export interface PortablePathSegment {
  name: string;
  path: string;
}

export interface ParsedPortablePath {
  normalized: string;
  rootLabel: string;
  rootPath: string;
  segments: PortablePathSegment[];
}

/**
 * Converts platform-specific local paths to the slash-separated format used by
 * the UI and Tauri command payloads.
 */
export function normalizePortablePath(path: string): string {
  let normalized = path.replace(/\\/g, '/');

  if (normalized.toUpperCase().startsWith('//?/UNC/')) {
    normalized = `//${normalized.slice(8)}`;
  } else if (normalized.startsWith('//?/')) {
    normalized = normalized.slice(4);
  }

  return normalized;
}

export function parsePortablePath(path: string): ParsedPortablePath {
  const normalized = normalizePortablePath(path);
  const driveMatch = normalized.match(/^([A-Za-z]:)(?:\/|$)/);
  const uncMatch = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/);

  let rootLabel = '/';
  let rootPath = '/';
  let remainder = normalized.replace(/^\/+/, '');

  if (driveMatch) {
    rootLabel = `${driveMatch[1]}/`;
    rootPath = rootLabel;
    remainder = normalized.slice(driveMatch[0].length);
  } else if (uncMatch) {
    rootLabel = `//${uncMatch[1]}/${uncMatch[2]}/`;
    rootPath = rootLabel;
    remainder = normalized.slice(uncMatch[0].length);
  }

  const names = remainder.split('/').filter(Boolean);
  const segments = names.map((name, index) => ({
    name,
    path: `${rootPath}${names.slice(0, index + 1).join('/')}`,
  }));

  return { normalized, rootLabel, rootPath, segments };
}

export function parentPortablePath(path: string): string {
  const parsed = parsePortablePath(path);
  if (parsed.segments.length <= 1) return parsed.rootPath;
  return parsed.segments[parsed.segments.length - 2].path;
}

export function isPortableRootPath(path?: string): boolean {
  return !path || parsePortablePath(path).segments.length === 0;
}
