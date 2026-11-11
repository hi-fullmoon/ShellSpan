import {nativeHistoryProbeCommand} from './native-history-plan';

export type ConcurrentHistoryStyle = 'SaveNothing' | 'SaveAtExit' | 'SaveIncrementally';
export type ConcurrentHistoryStage = 'probes' | 'firstExit' | 'bothExited';
export function nativeHistoryConcurrentPlan(token: string) {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw Error('Owned concurrent history token required');
  const markers = [0, 1].map(reader => `B07_CONCURRENT_${token}_${reader}_`);
  const sources = markers.map((marker, reader) => nativeHistoryProbeCommand.replace("('B07_'+'PROBE_')", `'${marker}'`).replace('@{path=', '@{host=[string]((Get-Host).Name);path=') + ` # 并发历史 reader${reader}`);
  const exits = [0, 1].map(reader => `exit 0 # B07_READER_${reader}_${token}`);
  return {markers, sources, exits};
}
function styleAndMaximum(style: string, maximum: number): asserts style is ConcurrentHistoryStyle {
  if (!['SaveNothing', 'SaveAtExit', 'SaveIncrementally'].includes(style) || !Number.isSafeInteger(maximum) || maximum < 1) throw Error('Actual history style and positive maximum required');
}
export function concurrentHistoryMemory(seeds: readonly string[], sources: readonly string[], reader: 0 | 1, style: string, maximum: number): string[] {
  styleAndMaximum(style, maximum);
  if (sources.length !== 2) throw Error('Both original concurrent sources required');
  // The pinned provider imports foreign incremental lines after writing the
  // local line. The public GetHistoryItems probe does not navigate history.
  return [...(style === 'SaveNothing' ? [] : seeds), sources[reader], ...(reader === 1 && style === 'SaveIncrementally' ? [sources[0]] : [])].slice(-maximum);
}
export function concurrentHistoryDisk(seeds: readonly string[], sources: readonly string[], exits: readonly string[], style: string, maximum: number, stage: ConcurrentHistoryStage): string[] {
  styleAndMaximum(style, maximum);
  if (sources.length !== 2 || exits.length !== 2 || !['probes', 'firstExit', 'bothExited'].includes(stage)) throw Error('Exact concurrent history stage required');
  if (style === 'SaveNothing') return [];
  if (style === 'SaveAtExit') return stage === 'probes' ? [...seeds] : [...seeds, sources[stage === 'firstExit' ? 0 : 1], exits[stage === 'firstExit' ? 0 : 1]].slice(-maximum);
  return [...seeds, ...sources, ...(stage === 'probes' ? [] : stage === 'firstExit' ? [exits[0]] : exits)];
}
