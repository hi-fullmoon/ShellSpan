export const DEFAULT_TAB_TITLE_TEMPLATE = '${name}';
export const MAX_TAB_TITLE_LENGTH = 4096;
export const TAB_TITLE_PRESETS = ['${name}', '${user}@${host}', '${name} · ${host}', '${host}:${port}', '${name} #${index}'] as const;
const variables = ['name', 'user', 'host', 'port', 'index'] as const;

interface TabTitleConnection {
  host: string;
  username: string;
  port: number;
}

export function resolveTabTitleValues(
  session?: TabTitleConnection & { title: string; baseTitle?: string; titleIndex?: number },
  profile?: TabTitleConnection & { name: string },
) {
  const host = session?.host ?? profile?.host ?? '';
  return {
    name: profile ? profile.name || host : (session?.baseTitle ?? session?.title) || host,
    user: session?.username ?? profile?.username ?? '',
    host,
    port: session?.port ?? profile?.port ?? 22,
    index: session?.titleIndex ?? 1,
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

export function formatTabTitle(template: string, values: { name: string; user: string; host: string; port: number; index: number }, custom = false): string {
  const source = validTabTitleTemplate(template) ? template : DEFAULT_TAB_TITLE_TEMPLATE;
  // A single replacement pass keeps values containing placeholder text literal.
  const expanded = source.replace(/\$\{(name|user|host|port|index)\}/g, (_, key: typeof variables[number]) => String(values[key]));
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const name = clean(values.name);
  const host = clean(values.host);
  const title = !custom && source === TAB_TITLE_PRESETS[2] && (!name || !host || name === host)
    ? name || host
    : clean(expanded) || name || host;
  // Match the workspace limit without splitting a UTF-16 surrogate pair.
  return title.slice(0, MAX_TAB_TITLE_LENGTH).replace(/[\uD800-\uDBFF]$/, '');
}
