import assert from 'node:assert/strict';
import {isAbsolute,resolve} from 'node:path';

const profiles=Object.freeze([
  Object.freeze({shell:'powerShell7',expectedVersion:'7.6.9'}),
]);

export function selectWindowsProfiles(selection){
  if(selection===undefined)return [...profiles];
  assert(selection.length>0&&new Set(selection).size===selection.length,'Select unique Windows host kinds');
  assert(selection.every(shell=>profiles.some(profile=>profile.shell===shell)),'Unsupported Windows host kind');
  return profiles.filter(profile=>selection.includes(profile.shell));
}

export function windowsValidationPaths(evidence){
  assert(typeof evidence==='string'&&isAbsolute(evidence),'Windows validation requires an absolute owned evidence directory');
  return {appDirectoriesOverride:resolve(evidence,'data'),dataDirectory:resolve(evidence,'webview'),
    powerShellModuleAnalysisCachePath:resolve(evidence,'powershell-module-analysis.cache')};
}

export function windowsShortSnapshotLocation(owner,id){
  assert(typeof owner==='string'&&isAbsolute(owner),'Windows snapshot requires an absolute owner directory');
  assert(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id),'Windows snapshot requires a UUID');
  const directory=resolve(owner,'.artifacts/tests/p3',id.replaceAll('-','').slice(0,8));
  return {directory,root:resolve(directory,'s')};
}
