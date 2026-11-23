import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search';
import { ArrowDownIcon, ArrowUpIcon, CaseSensitiveIcon, RegexIcon, WholeWordIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { resolveTerminalTheme } from './registry/terminal-registry';
import { terminalSearchDecorations } from '@/lib/terminal/terminal-colors';
import { eventMatchesShortcut } from '@/lib/shortcuts';
import type { TerminalSearchAddon } from './terminal-search-addon';

// Match the addon's separator set. The addon skips the rest of a line when
// its first substring match fails the whole-word check, so prefilter with
// zero-width boundaries and keep the built-in boundary check as well.
const WORD_CHARACTER = String.raw`[^ ~!@#$%^&*()+\x60\-= \[\]{}|\\;:"',./<>?]`;
const HAS_LOOKBEHIND = (() => {
  try {
    new RegExp('(?<!.)');
    return true;
  } catch {
    return false;
  }
})();

export function TerminalSearch({ addon, onClose, active = true, initialQuery = '' }: {
  addon?: TerminalSearchAddon;
  onClose: () => void;
  active?: boolean;
  initialQuery?: string;
}) {
  const { t } = useI18n();
  const colorScheme = useAppStore((state) => state.terminalColorScheme);
  const colorOverrides = useAppStore((state) => state.terminalColorOverrides);
  const theme = colorScheme === 'app' ? colorOverrides : resolveTerminalTheme(colorScheme, colorOverrides);
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
  const [query, setQuery] = useState(initialQuery);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const filterWholeWords = wholeWord && HAS_LOOKBEHIND;
  const searchTerm = useMemo(() => {
    if (!filterWholeWords || !query) return query;
    const pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return '(?<!' + WORD_CHARACTER + ')(?:' + pattern + ')(?!' + WORD_CHARACTER + ')';
  }, [filterWholeWords, query, regex]);
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
  const decorations = terminalSearchDecorations(resolveTerminalTheme(colorScheme, colorOverrides), colorOverrides);
  const options: ISearchOptions = {
    caseSensitive,
    regex: regex || filterWholeWords,
    wholeWord,
    decorations,
  };
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!active) return;
    const focusInput = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    focusInput();
    document.addEventListener('shellspan:find-terminal', focusInput);
    return () => document.removeEventListener('shellspan:find-terminal', focusInput);
  }, [active]);

  useEffect(() => {
    setResult(null);
    if (!addon || !query || invalidRegex) {
      addon?.clearSearch();
      return;
    }
    const subscription = addon.onDidChangeResults(setResult);
    // SearchAddon 0.16 does not invalidate highlights when only options change.
    // Clear its cached term here; next/previous navigation retains the cache.
    addon.clearDecorations();
    const found = addon.findNext(searchTerm, { ...optionsRef.current, incremental: true });
    if (!found) setResult({ resultIndex: -1, resultCount: 0 });
    return () => subscription.dispose();
  }, [addon, query, searchTerm, caseSensitive, regex, wholeWord, invalidRegex, decorations.matchBorder, decorations.activeMatchBorder, decorations.matchBackground, decorations.activeMatchBackground]);

  useEffect(() => () => addon?.clearSearch(), [addon]);

  const find = (previous: boolean) => {
    if (!query || !addon || invalidRegex) return;
    const found = previous
      ? addon.findPrevious(searchTerm, optionsRef.current)
      : addon.findNext(searchTerm, optionsRef.current);
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
    <div
      data-terminal-search
      style={surfaceStyle}
      className="absolute right-2 top-2 z-20 flex max-h-[calc(100%-0.5rem)] min-h-8 w-[26rem] max-w-[calc(100%-1rem)] flex-wrap items-center gap-x-1 gap-y-0.5 overflow-y-auto rounded-lg border px-1 py-0.5 shadow-md [&_button]:size-5"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        const previous = eventMatchesShortcut(event.nativeEvent, 'mod+shift+g');
        if (previous || eventMatchesShortcut(event.nativeEvent, 'mod+g')) {
          event.preventDefault();
          event.stopPropagation();
          find(previous);
          return;
        }
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <InputGroup style={{ backgroundColor: 'var(--background)' }} className="h-auto flex-[1_1_10.5rem] flex-wrap rounded-md">
        <InputGroupInput
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('terminal.search.placeholder')}
          aria-label={t('terminal.search.placeholder')}
          aria-invalid={invalidRegex || undefined}
          aria-describedby={statusId}
          className="h-5 min-w-[min(100%,6rem)] px-2 text-xs text-foreground"
          autoFocus
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key !== 'Enter') return;
            event.preventDefault();
            find(event.shiftKey);
          }}
        />
        <InputGroupAddon align="inline-end" className="ml-auto shrink-0 p-0.5 has-[>button]:mr-0">
          <Button variant={caseSensitive ? 'secondary' : 'ghost'} size="icon-xs" onClick={() => setCaseSensitive(!caseSensitive)} aria-pressed={caseSensitive} aria-label={t('terminal.search.caseSensitive')} title={t('terminal.search.caseSensitive')}>
            <CaseSensitiveIcon />
          </Button>
          <Button variant={regex ? 'secondary' : 'ghost'} size="icon-xs" onClick={() => setRegex(!regex)} aria-pressed={regex} aria-label={t('terminal.search.regex')} title={t('terminal.search.regex')}>
            <RegexIcon />
          </Button>
          <Button variant={wholeWord ? 'secondary' : 'ghost'} size="icon-xs" onClick={() => setWholeWord(!wholeWord)} aria-pressed={wholeWord} aria-label={t('terminal.search.wholeWord')} title={t('terminal.search.wholeWord')}>
            <WholeWordIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-x-1 gap-y-0.5">
        <span id={statusId} role="status" aria-live="polite" aria-atomic="true" aria-label={feedback || undefined} title={feedback} className="w-14 shrink-0 truncate text-center text-xs leading-none tabular-nums">
          {invalidRegex ? t('terminal.search.invalidRegexShort') : !query || result?.resultCount === 0 ? '0/0' : feedback}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-xs" disabled={!query || invalidRegex || result?.resultCount === 0} onClick={() => find(true)} aria-label={t('terminal.search.previous')} title={t('terminal.search.previous')}>
            <ArrowUpIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" disabled={!query || invalidRegex || result?.resultCount === 0} onClick={() => find(false)} aria-label={t('terminal.search.next')} title={t('terminal.search.next')}>
            <ArrowDownIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={t('terminal.search.close')} title={t('terminal.search.close')}>
            <XIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
