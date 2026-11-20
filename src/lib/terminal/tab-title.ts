export const DEFAULT_TAB_TITLE_TEMPLATE = '${name}';
export const MAX_TAB_TITLE_LENGTH = 4096;
export const TAB_TITLE_PRESETS = [
  '${name}', '${user}@${host}', '${name} · ${host}', '${host}:${port}', '${name} #${index}', '${cwd}', '${title}',
] as const;
const variables = ['name', 'user', 'host', 'port', 'index', 'cwd', 'title'] as const;

export function cleanTerminalTitle(value: string, limit = MAX_TAB_TITLE_LENGTH): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
}

interface TabTitleConnection {
  host: string;
  username: string;
  port: number;
}

export function resolveTabTitleValues(
  session?: TabTitleConnection & {
    title: string;
    baseTitle?: string;
    titleIndex?: number;
    currentDirectory?: string;
    oscTitle?: string;
  },
  profile?: TabTitleConnection & { name: string },
) {
  const host = session?.host ?? profile?.host ?? '';
  const name = profile ? profile.name || host : (session?.baseTitle ?? session?.title) || host;
  const directory = session?.currentDirectory;
  const separators = directory && /^(?:[A-Za-z]:|\\\\)/.test(directory) ? /[\\/]+/ : /\/+/;
  const parts = directory?.split(separators).filter(Boolean) ?? [];
  return {
    name,
    user: session?.username ?? profile?.username ?? '',
    host,
    port: session?.port ?? profile?.port ?? 22,
    index: session?.titleIndex ?? 1,
    cwd: parts[parts.length - 1] ?? directory ?? name,
    title: cleanTerminalTitle(session?.oscTitle ?? '') || name,
  };
}

export function validTabTitleTemplate(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  let remainder = value;
  for (const variable of variables) remainder = remainder.split(`\${${variable}}`).join('');
  return !remainder.includes('${');
}

export function normalizeTabTitleOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, template]) => validTabTitleTemplate(template))) as Record<string, string>;
}

export function formatTabTitle(template: string, values: {
  name: string; user: string; host: string; port: number; index: number; cwd?: string; title?: string;
}, custom = false): string {
  const source = validTabTitleTemplate(template) ? template : DEFAULT_TAB_TITLE_TEMPLATE;
  // A single replacement pass keeps values containing placeholder text literal.
  const expanded = source.replace(/\$\{(name|user|host|port|index|cwd|title)\}/g, (_, key: typeof variables[number]) => String(values[key] ?? values.name));
  const name = cleanTerminalTitle(values.name);
  const host = cleanTerminalTitle(values.host);
  return !custom && source === TAB_TITLE_PRESETS[2] && (!name || !host || name === host)
    ? name || host
    : cleanTerminalTitle(expanded) || name || host;
}
