import {nativeHistoryProbeCommand} from './native-history-plan';
import {nativeWindowsDraftSource} from './native-windows-draft-plan';

export function nativeHistoryLifecyclePlan(token: string) {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw Error('Owned history lifecycle token required');
  const initialMarker = `B07_INITIAL_${token}_`;
  const finalMarker = `B07_FINAL_${token}_`;
  const probe = (marker: string) => nativeHistoryProbeCommand.replace("('B07_'+'PROBE_')", `'${marker}'`);
  const accepted = Array.from({length: 5}, (_, index) => {
    const marker = `B07_ACCEPT_${token}_${index + 1}`;
    return {
      source: `[Console]::WriteLine(('B07_ACCEPT_'+'${token}'+'_'+'${index + 1}')) # 历史记录`,
      marker,
    };
  });
  return {initialMarker, finalMarker, initialProbe: probe(initialMarker), finalProbe: probe(finalMarker), accepted, draft: nativeWindowsDraftSource(token)};
}

export function nativeHistoryLifecycleGoal(source: string): string {
  return `Call run_terminal_command exactly ONCE with this exact raw PowerShell source. The fenced block is RAW TEXT,not a JSON literal;encode once,preserve every character including Unicode,quotes and backslashes,and do not include a trailing CR/LF. Use foreground cooperative execution. Do not use Direct,extra tools,retries or change source. Then reply done.\n~~~sh\n${source}\n~~~`;
}

export function matchesHistoryLifecycleArguments(value: unknown, source: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const args = value as Record<string, unknown>;
  return args.command === source
    && (args.background === undefined || args.background === false)
    && (args.lifecycleTrust === undefined || args.lifecycleTrust === 'cooperative')
    && (args.timeoutMs === undefined || typeof args.timeoutMs === 'number' && Number.isInteger(args.timeoutMs) && args.timeoutMs > 0)
    && (args.explanation === undefined || typeof args.explanation === 'string')
    && Object.keys(args).every(key => ['command', 'background', 'timeoutMs', 'lifecycleTrust', 'explanation'].includes(key));
}

export function expectedMemoryHistory(seeds: readonly string[], accepted: readonly string[], maximum: number): string[] {
  if (!Number.isInteger(maximum) || maximum < 1) throw Error('Actual positive history maximum required');
  return [...seeds, ...accepted].slice(-maximum);
}

export function expectedPersistedHistory(seeds: readonly string[], accepted: readonly string[], style: string, exited: boolean): string[] {
  if (style === 'SaveNothing') return [];
  if (style === 'SaveAtExit' && !exited) return [...seeds];
  if (!['SaveAtExit', 'SaveIncrementally'].includes(style)) throw Error('Actual public history save style required');
  // Incremental disk history is append-only between PSReadLine compactions.
  // MaximumHistoryCount bounds the in-memory list, not every disk append.
  return [...seeds, ...accepted, ...(exited ? ['exit'] : [])];
}

export function matchesHistoryFingerprints(value: unknown, expected: readonly {sha256: string; bytes: number}[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return Object.keys(item).length === 2 && item.sha256 === expected[index].sha256 && item.bytes === expected[index].bytes;
  });
}
