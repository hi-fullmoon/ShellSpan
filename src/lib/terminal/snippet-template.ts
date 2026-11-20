export interface SnippetInput {
  name: string;
  groupName: string;
  tags: string[];
  commandTemplate: string;
  description: string;
}

export interface CommandSnippet extends SnippetInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export interface SnippetParameter {
  name: string;
  defaultValue?: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const TOKEN = /\{\{([^{}]*)\}\}/g;

export function parseSnippetTemplate(template: string): SnippetParameter[] | null {
  if (!template.trim() || template.length > 4096 || CONTROL_CHARACTERS.test(template)) return null;
  const parameters = new Map<string, SnippetParameter>();
  let end = 0;
  for (const match of template.matchAll(TOKEN)) {
    if (/\{\{|\}\}/.test(template.slice(end, match.index))) return null;
    const separator = match[1].indexOf(':');
    const name = (separator < 0 ? match[1] : match[1].slice(0, separator)).trim();
    const defaultValue = separator < 0 ? undefined : match[1].slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return null;
    const previous = parameters.get(name);
    if (previous && defaultValue !== undefined && previous.defaultValue !== undefined
      && previous.defaultValue !== defaultValue) return null;
    parameters.set(name, { name, defaultValue: defaultValue ?? previous?.defaultValue });
    end = match.index + match[0].length;
  }
  return /\{\{|\}\}/.test(template.slice(end)) ? null : [...parameters.values()];
}

export function fillSnippetTemplate(template: string, values: Record<string, string>): string | null {
  const parameters = parseSnippetTemplate(template);
  if (!parameters) return null;
  const resolved = new Map<string, string>();
  for (const { name, defaultValue } of parameters) {
    const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : defaultValue;
    if (value === undefined || CONTROL_CHARACTERS.test(value)) return null;
    resolved.set(name, value);
  }
  const command = template.replace(TOKEN, (_token, body: string) => resolved.get(body.split(':', 1)[0].trim()) ?? '');
  return command.trim() && command.length <= 16_384 ? command : null;
}
