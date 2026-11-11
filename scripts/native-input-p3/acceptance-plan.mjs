import assert from 'node:assert/strict';
import {windowsPackageHost} from './package-config.mjs';
import {caseContract} from './acceptance-evidence.mjs';
import {digest} from './acceptance-inputs.mjs';
import {BASH_READLINE_VERSIONS,RELEASE_BASH_VERSION} from '../native-input-p2/bash-profiles.mjs';

const scenarios={
  ordinary:{requirements:['A03','A06','E03','E04'],stage:'ordinary',expected:{native:true,ordinaryOutputLines:1,agentOperations:0},evidence:['webview-evidence.json','application-ordinary.json','native-window.png']},
  'model-semantics':{requirements:['B04','E06'],stage:'semantics',expected:{variant:'headers',toolCalls:4,approvals:4,commandExitCodes:[0,0,1,0],unexpectedBody:false,parentRecovery:true},evidence:['semantics-webview-evidence.json','semantics-outcome.json','application-semantics.json','model-native-window.png']},
  'model-validation':{requirements:['B04','E06'],stage:'semantics',expected:{variant:'validation',toolCalls:4,approvals:4,commandExitCodes:[0,0,1,0],unexpectedBody:false,parentRecovery:true},evidence:['semantics-webview-evidence.json','semantics-outcome.json','application-semantics.json','model-native-window.png']},
  'model-file-chain':{requirements:['B08','E06'],stage:'file-chain',expected:{toolCalls:4,approvals:4,parentRecovery:true},evidence:['file-chain-webview-evidence.json','file-chain-outcome.json','application-file-chain.json','model-native-window.png']},
};
export function packageCases({hosts,selected,artifact,inputs}){
  assert(hosts.length&&selected.length);assert.equal(new Set(hosts).size,hosts.length);assert.equal(new Set(selected).size,selected.length);
  return hosts.flatMap(host=>selected.map(scenario=>{
    assert(scenario in scenarios,'Scenario requires its original dedicated package acceptance; manual/deferred tests cannot be scheduled here');
    const profile=windowsPackageHost(host),entry=scenarios[scenario];
    return caseContract({id:`windows-conpty/${host}/${scenario}`,requirements:entry.requirements,
      host:{platform:'windows-x64',...profile},transport:'ConPTY',artifact,scenario,stage:entry.stage,
      expected:entry.expected,inputs,evidence:['result.json','plan.json','foreground.jsonl',...entry.evidence]});
  }));
}

// The full checklist is an obligation inventory, never a declaration that this
// Windows package runner can execute every requirement/platform combination.
export function checklistObligations(text){
  const requirements=[...text.matchAll(/^- \[.\] ([A-E]\d{2}) (.+)$/gm)].map(([,id,description])=>({id,description}));
  assert.equal(requirements.length,35,'Checklist requirements changed; review expansion before scheduling');
  const windows={platform:'windows-x64',transport:'ConPTY',...windowsPackageHost()};
  const bash=`bash${RELEASE_BASH_VERSION}-readline${BASH_READLINE_VERSIONS[RELEASE_BASH_VERSION]}`;
  const unix=['macos-arm64/local-PTY','linux-aarch64-glibc2.36/SSH-PTY'].flatMap(target=>[bash,'zsh5.9-zle5.9'].map(shell=>({target,shell})));
  const platforms=[windows,...unix];
  return {checklistSha256:digest(text),requirements,platforms,
    obligations:requirements.flatMap(requirement=>platforms.map(host=>({id:`${requirement.id}/${host.target??host.platform}/${host.shell}`,requirement:requirement.id,host,
      status:host.target?'blocked':'pending',reason:host.target?'Required actual macOS arm64 or controlled Linux SSH environment unavailable':'Detailed required subcases and applicable exclusions must be reviewed; package subset cannot pass parent requirement'}))),
    deferred:['Ctrl+Shift+C','manual-copy'],fullAcceptancePassed:false};
}
