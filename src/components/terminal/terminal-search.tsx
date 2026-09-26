import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { SearchAddon, ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search';
import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { resolveTerminalTheme } from './registry/terminal-registry';

export function TerminalSearch({ terminal, addon, onClose, active = true }: {
  terminal?: Terminal;
  addon?: SearchAddon;
  onClose: () => void;
  active?: boolean;
}) {
  const { t } = useI18n();
  const colorScheme = useAppStore((state) => state.terminalColorScheme);
  const theme = colorScheme === 'app' ? undefined : resolveTerminalTheme(colorScheme);
  const background = theme?.background ?? 'var(--app-surface)';
  const foreground = theme?.foreground ?? 'var(--app-text)';
  // Scope the shared control tokens to this floating terminal surface.
  const surfaceStyle = {
    '--background': background,
    '--foreground': foreground,
    '--muted-foreground': foreground,
    '--input': `color-mix(in srgb, ${foreground} 25%, ${background})`,
    '--ring': theme?.cursor ?? 'var(--app-primary)',
    '--accent': `color-mix(in srgb, ${foreground} 12%, ${background})`,
    '--accent-foreground': foreground,
    '--secondary': `color-mix(in srgb, ${foreground} 20%, ${background})`,
    '--secondary-foreground': foreground,
    backgroundColor: `color-mix(in srgb, ${foreground} 5%, ${background})`,
    color: foreground,
    borderColor: 'var(--input)',
  } as CSSProperties;
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const statusId = useId();
  const invalidRegex = useMemo(() => {
    if (!regex || !query) return false;
    try {
      new RegExp(query, caseSensitive ? 'g' : 'gi');
      return false;
    } catch {
      return true;
    }
  }, [regex, query, caseSensitive]);
  const [result, setResult] = useState<ISearchResultChangeEvent | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Use the terminal palette for xterm's search decorations.
  const color = terminal?.options.theme?.blue ?? '#808080';
  const options: ISearchOptions = {
    caseSensitive,
    regex,
    decorations: {
      matchBorder: color,
      activeMatchBorder: terminal?.options.theme?.foreground ?? color,
      matchOverviewRuler: color,
      activeMatchColorOverviewRuler: color,
    },
  };
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!active) return;
    const focusInput = () => inputRef.current?.focus();
    document.addEventListener('shellspan:find-terminal', focusInput);
    return () => document.removeEventListener('shellspan:find-terminal', focusInput);
  }, [active]);

  useEffect(() => {
    setResult(null);
    if (!addon || !query || invalidRegex) {
      addon?.clearDecorations();
      return;
    }
    const subscription = addon.onDidChangeResults(setResult);
    // SearchAddon 0.16 does not invalidate highlights when only options change.
    // Clear its cached term here; next/previous navigation retains the cache.
    addon.clearDecorations();
    const found = addon.findNext(query, { ...optionsRef.current, incremental: true });
    if (!found) setResult({ resultIndex: -1, resultCount: 0 });
    return () => subscription.dispose();
  }, [addon, query, caseSensitive, regex, invalidRegex, color]);

  useEffect(() => () => addon?.clearDecorations(), [addon]);

  const find = (previous: boolean) => {
    if (!query || !addon || invalidRegex) return;
    const found = previous
      ? addon.findPrevious(query, optionsRef.current)
      : addon.findNext(query, optionsRef.current);
    if (!found) setResult({ resultIndex: -1, resultCount: 0 });
  };

  const feedback = invalidRegex ? t('terminal.search.invalidRegex') : !query || !result ? '' : result.resultCount === 0
    ? t('terminal.search.noResults')
    : result.resultIndex < 0
      ? t('terminal.search.manyResults', { count: result.resultCount })
      // SearchAddon defaults to at most 1,000 tracked results. Navigation still
      // works beyond that limit, but the count is only a lower bound.
      : t(result.resultCount >= 1000 ? 'terminal.search.cappedResults' : 'terminal.search.results', { current: result.resultIndex + 1, count: result.resultCount });

  return (
    <div data-terminal-search style={surfaceStyle} className="absolute right-2 top-2 z-20 flex w-80 max-w-[calc(100%-1rem)] flex-wrap items-center gap-1 rounded-md border p-1 shadow-md">
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('terminal.search.placeholder')}
        aria-label={t('terminal.search.placeholder')}
        aria-invalid={invalidRegex || undefined}
        aria-describedby={statusId}
        className="h-6 min-w-0 flex-[1_0_6rem] px-2 text-xs"
        autoFocus
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            find(event.shiftKey);
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1 [&>button]:shrink-0">
        <span id={statusId} role="status" aria-live="polite" aria-atomic="true" aria-label={feedback || undefined} title={feedback} className="w-14 shrink-0 truncate text-center text-xs tabular-nums">
          {invalidRegex ? t('terminal.search.invalidRegexShort') : !query || result?.resultCount === 0 ? '0/0' : feedback}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-xs" disabled={!query || invalidRegex || result?.resultCount === 0} onClick={() => find(true)} aria-label={t('terminal.search.previous')} title={t('terminal.search.previous')}>
            <ChevronUpIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" disabled={!query || invalidRegex || result?.resultCount === 0} onClick={() => find(false)} aria-label={t('terminal.search.next')} title={t('terminal.search.next')}>
            <ChevronDownIcon />
          </Button>
        </div>
        <Button variant={caseSensitive ? 'secondary' : 'ghost'} size="icon-xs" onClick={() => setCaseSensitive(!caseSensitive)} aria-pressed={caseSensitive} aria-label={t('terminal.search.caseSensitive')} title={t('terminal.search.caseSensitive')}>
          Aa
        </Button>
        <Button variant={regex ? 'secondary' : 'ghost'} size="icon-xs" onClick={() => setRegex(!regex)} aria-pressed={regex} aria-label={t('terminal.search.regex')} title={t('terminal.search.regex')}>
          .*
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={t('terminal.search.close')} title={t('terminal.search.close')}>
          <XIcon />
        </Button>
      </div>
    </div>
  );
}
