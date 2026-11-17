import assert from 'node:assert/strict';
import fs from 'node:fs';
import p from 'node:path';
import {createHash} from 'node:crypto';
import {prepareWindowsHistoryProfile} from './windows-history-profile.mjs';

// A separate fixture preserves the original fresh-namespace history modes.
// Prepare once; subsequent real readers consume the existing file without reseeding.
export function prepareWindowsHistoryReuseProfile(options) {
  const {evidence, reuseId} = options;
  assert(typeof reuseId === 'string' && /^[a-f0-9-]{36}$/.test(reuseId), 'Exact owned history reuse identity required');
  const project = p.resolve(import.meta.dirname, '../..');
  const relative = p.relative(p.join(project, 'artifacts/tests'), p.resolve(evidence));
  assert(relative && !relative.startsWith('..') && !p.isAbsolute(relative), 'History reuse requires project test evidence');
  let cursor = p.resolve(evidence);
  while (fs.existsSync(cursor)) {
    assert(!fs.lstatSync(cursor).isSymbolicLink(), 'History reuse ancestor cannot be a link');
    const parent = p.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const plan = prepareWindowsHistoryProfile(options);
  const helper = p.join(project, 'scripts/fixtures/windows-history-reuse-seed.ps1');
  const marker = p.join(evidence, 'native-history-reuse');
  const launches = p.join(marker, 'launches');
  fs.mkdirSync(launches, {recursive: true});
  const reusePlan = p.join(marker, 'plan.json');
  const seedText = plan.seedSources.join('\n') + '\n';
  fs.writeFileSync(reusePlan, JSON.stringify({
    version: 1, reuseId, evidence: p.resolve(evidence), history: plan.history,
    host: plan.host, mode: plan.mode, maximumVariable: plan.maximumVariable,
    seedText, seedSha256: createHash('sha256').update(seedText).digest('hex'),
  }), {flag: 'wx'});
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  let source = fs.readFileSync(plan.profile, 'utf8');
  const guard = "if ([IO.File]::Exists($h)) { throw 'History namespace already exists' }";
  const seed = `if ([string]$o.HistorySaveStyle -cne 'SaveNothing') { [IO.File]::WriteAllText($h,${quote(seedText)},[Text.UTF8Encoding]::new($false)) }`;
  const publish = source.split('\n').find(line => line.startsWith('[IO.File]::WriteAllText('));
  assert(source.includes(guard) && source.includes(seed) && publish, 'Original history profile contract changed');
  source = source.replace(guard, '');
  source = source.replace(seed, `$reuseState=& ${quote(helper)} -Plan ${quote(reusePlan)} -Style ([string]$o.HistorySaveStyle)`);
  source = source.replace(publish, `$r['seedApplied']=$reuseState.seedApplied
$r['historyBeforeReader']=$reuseState.historyBeforeReader
$r['readerPid']=$PID
$r['readerCreated']=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o')
$r['reuseId']=${quote(reuseId)}
$r['profilePath']=[string]$PSCommandPath
$receipt=Join-Path ${quote(launches)} ($PID.ToString()+'-'+[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString()+'.json')
$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($r|ConvertTo-Json -Compress -Depth 6))
$stream=[IO.File]::Open($receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
if(-not [IO.File]::Exists(${quote(plan.record)})){[IO.File]::Copy($receipt,${quote(plan.record)},$false)}`);
  fs.writeFileSync(plan.profile, source);
  return {...plan, reuseId, reusePlan, marker, launches, reusable: true,
    profileSha256: createHash('sha256').update(source).digest('hex'),
    helperSha256: createHash('sha256').update(fs.readFileSync(helper)).digest('hex')};
}
