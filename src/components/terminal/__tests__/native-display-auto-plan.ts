export const nativeDisplayAutoSizes = [
  {width: '100%', height: '100%'},
  {width: '440px', height: '320px'},
  {width: '360px', height: '580px'},
  {width: '100%', height: '320px'},
  {width: '760px', height: '520px'},
  {width: '100%', height: '100%'},
] as const;

/** Selection anchors apply to horizontal reflow; vertical resize clears selection. */
export function nativeDisplayViewportSizes(parked: boolean) {
  return [nativeDisplayAutoSizes[1], nativeDisplayAutoSizes[2], nativeDisplayAutoSizes[5]]
    .map(size => ({width: size.width, height: parked ? '320px' : size.height}));
}

export function nativeDisplayPrompt(cwd: string | null | undefined): string | null {
  return cwd ? 'PS ' + cwd.split('/').join('\\') + '>' : null;
}

export function nativeDisplayActivePlan(token: string, index: number) {
  const base = nativeDisplayAutoPlan(token, index, 400);
  const marker = `ACTIVE_${token.slice(0, 8)}_${index}_中文_é_👩🏽‍💻`;
  const prefix = `[Console]::WriteLine('${marker}`;
  const source = prefix + "'); " + base.source;
  return {...base, source, prefix, suffix: source.slice(prefix.length), lines: [marker, ...base.lines]};
}

export function nativeDisplayAutoPlan(token: string, index: number, columns: number) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)
    || !Number.isInteger(index) || index < 0 || index >= nativeDisplayAutoSizes.length
    || !Number.isInteger(columns) || columns < 20 || columns > 400) throw Error('Owned bounded native display scene required');
  const id = token.slice(0, 8), prefix = `DA_${id}_${index}_`;
  const geometry = `DG_${id}_${index}_`;
  const lines = [
    prefix + 'BEGIN',
    prefix + 'ASCII_0123456789',
    prefix + 'UNICODE_中文宽字符_é_👩🏽‍💻_END',
    prefix + 'LONG_' + 'abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(columns * 3 / 26)) + '_END',
    prefix + 'HARD_A', prefix + 'HARD_B', prefix + 'END',
  ];
  const payload = lines.join('\n');
  const encoded = btoa(Array.from(new TextEncoder().encode(payload), byte => String.fromCharCode(byte)).join(''));
  const source = `[Console]::WriteLine(('DG_'+'${id}'+'_${index}_'+[Console]::WindowWidth+'x'+[Console]::WindowHeight)); [Console]::WriteLine([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`;
  return {index, geometry, lines, payload, encoded, source, end: lines[lines.length - 1]};
}

export function nativeDisplayGeometry(text: string, marker: string): {columns: number; rows: number} | null {
  if (!/^DG_[a-f0-9]{8}_[0-5]_$/.test(marker)) throw Error('Owned display geometry marker required');
  const matches = [...text.matchAll(new RegExp(marker + '(\\d+)x(\\d+)', 'g'))];
  if (matches.length !== 1) return null;
  const columns = Number(matches[0][1]), rows = Number(matches[0][2]);
  return Number.isSafeInteger(columns) && columns > 0 && Number.isSafeInteger(rows) && rows > 0 ? {columns, rows} : null;
}
