import type { Platform } from '@/lib/platform';
import type { TerminalFontFamily } from '@/types';

const TERMINAL_FONT_FAMILIES: Record<TerminalFontFamily, string> = {
  system: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  menlo: 'Menlo, monospace',
  monaco: 'Monaco, monospace',
  consolas: 'Consolas, monospace',
  courierNew: '"Courier New", monospace',
};

export const DEFAULT_TERMINAL_FONT_SIZE = 14;

export function normalizeTerminalFontSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(32, Math.max(10, Math.round(value)))
    : DEFAULT_TERMINAL_FONT_SIZE;
}

export function normalizeTerminalFontName(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 128).replace(/[\uD800-\uDBFF]$/, '')
    : '';
}

export function terminalFontStack(family: TerminalFontFamily, custom?: string): string {
  const fallback = TERMINAL_FONT_FAMILIES[family] ?? TERMINAL_FONT_FAMILIES.system;
  const name = normalizeTerminalFontName(custom).trim();
  return name ? '"' + name.replace(/["\\]/g, '\\$&') + '", ' + fallback : fallback;
}

export function terminalFontSizeAfterKey(event: KeyboardEvent, platform: Platform, size: number): number | null {
  const modifier = platform === 'macos' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.isComposing) return null;
  if (event.key === '=' || event.key === '+') return normalizeTerminalFontSize(size + 1);
  if (event.shiftKey) return null;
  if (event.key === '-') return normalizeTerminalFontSize(size - 1);
  if (event.key === '0') return DEFAULT_TERMINAL_FONT_SIZE;
  return null;
}
