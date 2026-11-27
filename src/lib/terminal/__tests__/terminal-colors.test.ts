import { beforeAll, describe, expect, it } from 'vitest';
import { enableRealCanvas } from '@/tests/real-canvas';
import {
  applyTerminalColorOverrides,
  DEFAULT_TERMINAL_MINIMUM_CONTRAST_RATIO,
  LIGHT_TERMINAL_ANSI_COLORS,
  normalizeTerminalColorOverrides,
  normalizeTerminalMinimumContrastRatio,
  TERMINAL_ANSI_COLOR_KEYS,
  terminalSearchDecorations,
} from '../terminal-colors';
import { useAppStore } from '@/stores/appStore';

describe('terminal custom colors', () => {
  beforeAll(enableRealCanvas);
  it('only accepts supported color keys and complete hexadecimal colors', () => {
    expect(normalizeTerminalColorOverrides({
      background: '#123456', foreground: '#ABCDEF', selectionBackground: '#12345680',
      red: 'red', green: '#12', blue: 'url(https://example.com)', cursor: 42,
      extendedAnsi: ['#123456'], overviewRulerBorder: '#123456',
      searchMatchBackground: '#102030',
    })).toEqual({ background: '#123456', foreground: '#abcdef', selectionBackground: '#12345680', searchMatchBackground: '#102030' });
    expect(normalizeTerminalColorOverrides(null)).toEqual({});
    expect(normalizeTerminalColorOverrides(['#123456'])).toEqual({});
    expect(normalizeTerminalColorOverrides(Object.create({ background: '#123456' }))).toEqual({});
  });

  it('keeps unmodified preset colors and excludes search options from the xterm theme', () => {
    const preset = { background: '#000000', foreground: '#ffffff', red: '#cc0000' };
    const custom = { red: '#aabbcc', searchMatchBackground: '#ddeeff' };
    expect(applyTerminalColorOverrides(preset, custom)).toEqual({ ...preset, red: '#aabbcc' });
    expect(applyTerminalColorOverrides(preset, {})).toEqual(preset);
    expect(preset.red).toBe('#cc0000');
  });

  it('updates and restores both search highlight backgrounds without losing preset borders', () => {
    const theme = { foreground: '#ffffff', blue: '#3465a4' };
    expect(terminalSearchDecorations(theme, { searchMatchBackground: '#334455', searchActiveMatchBackground: '#667788' })).toMatchObject({
      matchBackground: '#334455', activeMatchBackground: '#667788', matchBorder: '#3465a4', activeMatchBorder: '#ffffff',
    });
    expect(terminalSearchDecorations(theme, {}).matchBackground).toBeUndefined();
    expect(terminalSearchDecorations(theme, {}).activeMatchBackground).toBeUndefined();
  });

  it('retains overrides when switching presets and restores only the color overrides', () => {
    const before = useAppStore.getState();
    try {
      before.setTerminalColorScheme('nord');
      before.setTerminalColorOverrides({ red: '#AABBCC' });
      before.setTerminalColorScheme('dracula');
      expect(useAppStore.getState().terminalColorOverrides).toEqual({ red: '#aabbcc' });
      before.setTerminalColorOverrides({});
      expect(useAppStore.getState().terminalColorScheme).toBe('dracula');
      expect(useAppStore.getState().terminalColorOverrides).toEqual({});
      expect(useAppStore.getState().terminalFontSize).toBe(before.terminalFontSize);
    } finally {
      useAppStore.setState({ terminalColorScheme: before.terminalColorScheme, terminalColorOverrides: before.terminalColorOverrides });
    }
  });

  it('composites transparent search highlights against the current terminal background', () => {
    const overrides = { searchMatchBackground: '#ff000080', searchActiveMatchBackground: '#ff000000' };
    expect(terminalSearchDecorations({ background: '#000000' }, overrides)).toMatchObject({ matchBackground: '#800000', activeMatchBackground: '#000000' });
    expect(terminalSearchDecorations({ background: '#ffffff' }, overrides)).toMatchObject({ matchBackground: '#ff7f7f', activeMatchBackground: '#ffffff' });
    expect(terminalSearchDecorations({ background: '#123456' }, { searchMatchBackground: '#aabbccff' }).matchBackground).toBe('#aabbcc');
  });

  it('normalizes supported minimum contrast ratios and provides a complete 16-color light ANSI palette', () => {
    expect(DEFAULT_TERMINAL_MINIMUM_CONTRAST_RATIO).toBe(4.5);
    expect(normalizeTerminalMinimumContrastRatio(1)).toBe(1);
    expect(normalizeTerminalMinimumContrastRatio(4.5)).toBe(4.5);
    expect(normalizeTerminalMinimumContrastRatio(7)).toBe(7);
    expect(normalizeTerminalMinimumContrastRatio(0)).toBe(4.5);
    expect(normalizeTerminalMinimumContrastRatio(99)).toBe(4.5);
    expect(normalizeTerminalMinimumContrastRatio('4.5')).toBe(4.5);
    expect(normalizeTerminalMinimumContrastRatio(undefined)).toBe(4.5);

    for (const key of TERMINAL_ANSI_COLOR_KEYS) {
      expect(LIGHT_TERMINAL_ANSI_COLORS[key]).toMatch(/^#[\da-f]{6}$/);
    }
    expect(LIGHT_TERMINAL_ANSI_COLORS.brightYellow).toBe('#9a6700');
  });
});
