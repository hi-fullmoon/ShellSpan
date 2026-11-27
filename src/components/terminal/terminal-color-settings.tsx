import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import {
  DEFAULT_TERMINAL_ANSI_COLORS, isTerminalColor, TERMINAL_ANSI_COLOR_KEYS, TERMINAL_BASIC_COLOR_KEYS, TERMINAL_SEARCH_COLOR_KEYS, TERMINAL_COLOR_KEYS,
  terminalSearchDecorations, type TerminalColorKey, type TerminalColorOverrides,
} from '@/lib/terminal/terminal-colors';
import { resolveTerminalTheme } from './registry/terminal-registry';
import { TERMINAL_COLOR_SCHEME_IDS, type TerminalColorScheme } from '@/types';

// Let the browser resolve preset CSS colors, including rgba and modern CSS colors.
function colorHex(color: string): string {
  if (isTerminalColor(color)) return color.toLowerCase();
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return '#000000';
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const channels = Array.from(context.getImageData(0, 0, 1, 1).data);
  return `#${channels.slice(0, channels[3] === 255 ? 3 : 4).map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function ColorField({ colorKey, inherited, value, onChange }: {
  colorKey: TerminalColorKey;
  inherited?: string;
  value?: string;
  onChange: (key: TerminalColorKey, value?: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const pickerRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const effective = value ?? inherited;
  const text = draft ?? effective ?? '';
  const invalid = text !== '' && !isTerminalColor(text);
  const isModified = value !== undefined || draft !== null;
  const label = t(`settings.terminal.colors.${colorKey}`);
  const displayedColor = useMemo(() => effective ? colorHex(effective) : undefined, [effective]);
  const pickerValue = displayedColor?.slice(0, 7) ?? '#000000';
  return (
    <Field data-invalid={invalid || undefined}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <FieldLabel id={`${id}-label`} htmlFor={id} className="truncate">{label}</FieldLabel>
        {isModified ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="-mr-1.5 h-5 shrink-0 px-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
            aria-label={t('settings.terminal.colors.resetColor', { name: label })}
            title={t('settings.terminal.colors.resetColor', { name: label })}
            onClick={() => { setDraft(null); onChange(colorKey); }}
          >
            {t('settings.terminal.colors.resetOne')}
          </Button>
        ) : (
          <span className="shrink-0 text-xs leading-5 text-muted-foreground">{t('settings.terminal.colors.inherit')}</span>
        )}
      </div>
      <InputGroup className="h-9 min-w-0 rounded-md" aria-labelledby={`${id}-label`}>
        <InputGroupInput
          id={id}
          className={cn('h-full min-w-0 pt-1.5 pb-1 font-mono', !isModified && 'text-muted-foreground focus:text-foreground')}
          value={text}
          placeholder={t('settings.terminal.colors.noBackground')}
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={event => {
            const next = event.target.value;
            setDraft(next);
            if (next === '' || isTerminalColor(next)) onChange(colorKey, next || undefined);
          }}
          onBlur={() => { if (!invalid) setDraft(null); }}
        />
        <InputGroupAddon align="inline-start" className="py-0">
          <InputGroupButton
            size="icon-xs"
            data-color-swatch
            aria-label={t('settings.terminal.colors.picker', { name: label })}
            onClick={() => pickerRef.current?.click()}
          >
            <span aria-hidden="true" className="relative size-4 overflow-hidden rounded-sm border border-input" style={{ backgroundImage: 'conic-gradient(color-mix(in srgb, var(--foreground) 20%, var(--background)) 25%, var(--background) 0 50%, color-mix(in srgb, var(--foreground) 20%, var(--background)) 0 75%, var(--background) 0)', backgroundSize: '8px 8px' }}>
              <span data-swatch-color className="absolute inset-0" style={{ backgroundColor: displayedColor ?? 'transparent' }} />
            </span>
          </InputGroupButton>
          <InputGroupInput
            ref={pickerRef}
            type="color"
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
            value={pickerValue}
            onClick={event => event.stopPropagation()}
            onChange={event => {
              setDraft(null);
              onChange(colorKey, event.target.value + (displayedColor?.length === 9 ? displayedColor.slice(7) : ''));
            }}
          />
        </InputGroupAddon>
      </InputGroup>
      <FieldError id={`${id}-error`}>{invalid ? t('settings.terminal.colors.invalid') : null}</FieldError>
    </Field>
  );
}

function TerminalColorPreview({ colors }: { colors: Record<TerminalColorKey, string | undefined> }) {
  const { t } = useI18n();
  const scheme = useAppStore(state => state.terminalColorScheme);
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const terminal = new Terminal({
      cols: 36, rows: 4, fontSize: 13, lineHeight: 1.3,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      disableStdin: true, scrollback: 0, cursorBlink: false, cursorInactiveStyle: 'block', allowProposedApi: true,
      minimumContrastRatio: useAppStore.getState().terminalMinimumContrastRatio,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    const updateTheme = () => {
      if (disposed) return;
      const { terminalColorScheme, terminalColorOverrides, terminalMinimumContrastRatio } = useAppStore.getState();
      const theme = resolveTerminalTheme(terminalColorScheme, terminalColorOverrides);
      terminal.options.theme = theme;
      terminal.options.minimumContrastRatio = terminalMinimumContrastRatio;
      host.style.backgroundColor = theme?.background ?? '';
      if (terminal.element) {
        terminal.element.style.backgroundColor = theme?.background ?? '';
        const viewport = terminal.element.querySelector<HTMLElement>('.xterm-viewport');
        if (viewport) viewport.style.backgroundColor = theme?.background ?? '';
      }
      search.clearDecorations();
      search.findNext(t('settings.terminal.colors.previewMatch'), {
        decorations: terminalSearchDecorations(theme, terminalColorOverrides),
      });
      terminal.clearSelection();
    };
    terminal.open(host);
    fit.fit();
    const greeting = t('settings.terminal.colors.previewGreeting');
    const match = t('settings.terminal.colors.previewMatch');
    terminal.write(`\x1b[32m$\x1b[0m echo "${greeting}"\r\n${greeting}\r\n${match}  ${match}\r\n$ ${t('settings.terminal.colors.previewCursor')} A\x1b[D`, updateTheme);
    updateTheme();
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.terminalColorScheme !== previous.terminalColorScheme
        || state.terminalColorOverrides !== previous.terminalColorOverrides
        || state.terminalMinimumContrastRatio !== previous.terminalMinimumContrastRatio
      ) updateTheme();
    });
    const resize = new ResizeObserver(() => { fit.fit(); updateTheme(); });
    resize.observe(host);
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      disposed = true;
      unsubscribe();
      resize.disconnect();
      themeObserver.disconnect();
      terminal.dispose();
    };
  }, [t]);
  const presetLabel = t('settings.terminal.colors.base', { name: t(`settings.terminal.colorScheme.${scheme}`) });
  // xterm renders an opaque selection background at 30% opacity.
  const selectionColor = (color?: string) => color?.length === 7 ? `${color}4d` : color;
  return (
    <Card size="sm" radius="compact" variant="outline" className="shrink-0 gap-0 overflow-hidden py-0" role="region" aria-label={t('settings.terminal.colors.preview')}>
      <CardHeader className="flex min-w-0 flex-row items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-3 py-2">
        <CardTitle className="shrink-0">{t('settings.terminal.colors.previewTitle')}</CardTitle>
        <CardDescription className="min-w-0 truncate text-xs" title={presetLabel}>{presetLabel}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div style={{ backgroundColor: colors.background, color: colors.foreground }}>
          <div ref={hostRef} data-terminal-color-preview className="h-24 min-w-0 overflow-hidden [&>.xterm]:px-3 [&>.xterm]:py-2" />
          <div
            className="grid grid-cols-1 gap-2.5 border-t px-3 py-2.5 @min-[32rem]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] @min-[32rem]:items-center @min-[32rem]:gap-4"
            style={{ borderColor: `color-mix(in srgb, ${colors.foreground} 12%, transparent)` }}
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              {[false, true].map(bright => (
                <div key={String(bright)} className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-2">
                  <span className="truncate text-xs opacity-75">{t(bright ? 'settings.terminal.colors.previewBright' : 'settings.terminal.colors.previewNormal')}</span>
                  <div className="grid grid-cols-8 gap-1.5" data-ansi-palette={bright ? 'bright' : 'normal'}>
                    {TERMINAL_ANSI_COLOR_KEYS.slice(bright ? 8 : 0, bright ? 16 : 8).map(key => <span key={key} className="h-3.5 rounded-sm" style={{ backgroundColor: colors[key], boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${colors.foreground} 20%, transparent)` }} title={t(`settings.terminal.colors.${key}`)} />)}
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {(['selectionBackground', 'selectionInactiveBackground'] as const).map(key => (
                <div key={key} className="flex min-w-0 flex-col gap-1">
                  <span className="truncate text-xs opacity-75">{t(key === 'selectionBackground' ? 'settings.terminal.colors.activeSelection' : 'settings.terminal.colors.inactiveSelection')}</span>
                  <span data-selection-preview={key} className="w-fit max-w-full truncate rounded-sm px-1 text-xs leading-5" style={{ backgroundColor: selectionColor(colors[key]), color: colors.selectionForeground }}>{t('settings.terminal.colors.previewSelection')}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TerminalColorEditor({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const scheme = useAppStore(state => state.terminalColorScheme);
  const overrides = useAppStore(state => state.terminalColorOverrides);
  const setOverrides = useAppStore(state => state.setTerminalColorOverrides);
  const [resetVersion, setResetVersion] = useState(0);
  const [, setThemeVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeVersion(version => version + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  const baseTheme = resolveTerminalTheme(scheme, overrides) ?? {};
  const inherited: Record<TerminalColorKey, string | undefined> = {
    ...DEFAULT_TERMINAL_ANSI_COLORS,
    background: '#000000', foreground: '#ffffff', cursor: '#ffffff', cursorAccent: '#000000',
    selectionBackground: 'rgba(255, 255, 255, 0.3)',
    ...baseTheme,
    selectionForeground: baseTheme.selectionForeground ?? baseTheme.foreground ?? '#ffffff',
    selectionInactiveBackground: baseTheme.selectionInactiveBackground ?? baseTheme.selectionBackground ?? 'rgba(255, 255, 255, 0.3)',
    searchMatchBackground: overrides.searchMatchBackground,
    searchActiveMatchBackground: overrides.searchActiveMatchBackground,
  };
  for (const key of TERMINAL_COLOR_KEYS) {
    const color = inherited[key];
    if (color) inherited[key] = colorHex(color);
  }
  const onChange = (key: TerminalColorKey, value?: string) => {
    const next: TerminalColorOverrides = { ...useAppStore.getState().terminalColorOverrides };
    if (value) next[key] = value;
    else delete next[key];
    setOverrides(next);
  };
  const [activeTab, setActiveTab] = useState<'basic' | 'ansi' | 'search'>('basic');
  const countOverrides = (keys: readonly TerminalColorKey[]) => keys.filter(key => overrides[key] !== undefined).length;
  const basicCount = countOverrides(TERMINAL_BASIC_COLOR_KEYS);
  const ansiCount = countOverrides(TERMINAL_ANSI_COLOR_KEYS);
  const searchCount = countOverrides(TERMINAL_SEARCH_COLOR_KEYS);
  const field = (key: TerminalColorKey) => (
    <ColorField key={`${resetVersion}:${key}`} colorKey={key} inherited={inherited[key]} value={overrides[key]} onChange={onChange} />
  );
  return (
    <>
      <DialogHeader className="shrink-0 px-4 pr-12">
        <DialogTitle>{t('settings.terminal.colors.title')}</DialogTitle>
        <DialogDescription>{t('settings.terminal.colors.description')}</DialogDescription>
      </DialogHeader>
      <div className="shrink-0 px-4">
        <TerminalColorPreview colors={inherited} />
      </div>
      <Tabs
        value={activeTab}
        onValueChange={value => {
          if (value === 'basic' || value === 'ansi' || value === 'search') setActiveTab(value);
        }}
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
        <div className="shrink-0 px-4">
          <TabsList className="w-full @min-[28rem]:w-fit">
            <TabsTrigger value="basic" className="px-3">
              {t('settings.terminal.colors.tabBasic')}
              {basicCount > 0 && <span className="ml-1 text-xs text-muted-foreground tabular-nums">{basicCount}</span>}
            </TabsTrigger>
            <TabsTrigger value="ansi" className="px-3">
              {t('settings.terminal.colors.tabAnsi')}
              {ansiCount > 0 && <span className="ml-1 text-xs text-muted-foreground tabular-nums">{ansiCount}</span>}
            </TabsTrigger>
            <TabsTrigger value="search" className="px-3">
              {t('settings.terminal.colors.tabSearch')}
              {searchCount > 0 && <span className="ml-1 text-xs text-muted-foreground tabular-nums">{searchCount}</span>}
            </TabsTrigger>
          </TabsList>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <ScrollAreaContent className="px-4 pb-2">
            <TabsContent value="basic">
              <FieldGroup className="grid grid-cols-1 gap-3 @min-[28rem]:grid-cols-2">
                {TERMINAL_BASIC_COLOR_KEYS.map(field)}
              </FieldGroup>
            </TabsContent>
            <TabsContent value="ansi" className="flex flex-col gap-2">
              <div className="hidden grid-cols-2 gap-3 text-xs font-medium text-muted-foreground @min-[28rem]:grid">
                <span>{t('settings.terminal.colors.previewNormal')}</span>
                <span>{t('settings.terminal.colors.previewBright')}</span>
              </div>
              <FieldGroup className="grid grid-cols-1 gap-3 @min-[28rem]:grid-cols-2">
                {TERMINAL_ANSI_COLOR_KEYS.slice(0, 8).flatMap((key, index) => [
                  field(key), field(TERMINAL_ANSI_COLOR_KEYS[index + 8]),
                ])}
              </FieldGroup>
            </TabsContent>
            <TabsContent value="search">
              <FieldGroup className="grid grid-cols-1 gap-3 @min-[28rem]:grid-cols-2">
                {TERMINAL_SEARCH_COLOR_KEYS.map(field)}
              </FieldGroup>
            </TabsContent>
          </ScrollAreaContent>
        </ScrollArea>
      </Tabs>
      <DialogFooter className="shrink-0 flex-row justify-end px-4">
        <Button variant="outline" onClick={() => { setOverrides({}); setResetVersion(version => version + 1); }}>
          {t('settings.terminal.colors.reset')}
        </Button>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogFooter>
    </>
  );
}

export function TerminalColorSettings() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>{t('settings.terminal.colors.customize')}</Button>
      <DialogContent className="@container flex h-[min(48rem,calc(100dvh-2rem))] max-w-2xl flex-col gap-3 overflow-hidden px-0">
        {open && <TerminalColorEditor onClose={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

export function TerminalColorSchemeControl() {
  const { t } = useI18n();
  const scheme = useAppStore(state => state.terminalColorScheme);
  const setScheme = useAppStore(state => state.setTerminalColorScheme);
  const items = TERMINAL_COLOR_SCHEME_IDS.map(value => ({ value, label: t(`settings.terminal.colorScheme.${value}`) }));
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Select items={items} value={scheme} onValueChange={value => { if (value) setScheme(value as TerminalColorScheme); }}>
        <SelectTrigger size="sm" aria-label={t('settings.terminal.colorScheme')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
      <TerminalColorSettings />
    </div>
  );
}
