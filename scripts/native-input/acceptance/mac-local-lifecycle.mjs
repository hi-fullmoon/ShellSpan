import assert from 'node:assert/strict';
import {isAbsolute,resolve} from 'node:path';

export const macLifecycleVisualCheckpoints=Object.freeze(['lifecycle-ready','lifecycle-native-native','lifecycle-raw','lifecycle-final','lifecycle-late-ready','lifecycle-late-final','dispose-ready','dispose-armed','dispose-disposed','dispose-successor']);
export const macLifecycleSnapshotCheckpoints=Object.freeze([...macLifecycleVisualCheckpoints,'lifecycle-first-closed','lifecycle-utf8-closed','lifecycle-late-isolated','lifecycle-complete','lifecycle-failure','lifecycle-failure-closed','dispose-complete','dispose-failure','dispose-failure-closed']);

export function macLifecycleEvidenceClockEnabled(selected,environment=process.env){
 const value=environment.SHELLSPAN_ACCEPTANCE_LIFECYCLE_EVIDENCE_CLOCK;
 if(value===undefined)return false;
 assert(value==='1'&&selected===true&&process.platform==='darwin'&&process.arch==='arm64',
  'Lifecycle evidence clock requires an explicit isolated macOS no-model local lifecycle case');
 return true;
}

// Selection only. The existing foreground gate and frozen-source/image checks
// still authorize and verify the actual native run later in the main driver.
export function isMacLocalLifecycle(values,paths={
 evidence:process.env.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR,
 data:process.env.SHELLSPAN_DATA_DIR,
 home:process.env.SHELLSPAN_LOCAL_HOME,
}) {
 if(process.platform!=='darwin'||process.arch!=='arm64'||values['native-input-p2-lifecycle']!==true||values['native-input-p2-ssh-fixture'])return false;
 const zsh=values['native-input-p3']==='zsh'&&!values['native-input-p2'];
 const bash=values['native-input-p2']===true&&!values['native-input-p3'];
 assert((zsh||bash)&&values['no-model']===true
  &&values['data-scope']===(zsh?'com.shellspan.validation.native-input-p3':'com.shellspan.validation.native-input-p2')
  &&typeof paths.evidence==='string'&&isAbsolute(paths.evidence)
  &&paths.data===resolve(paths.evidence,'data')&&paths.home===resolve(paths.evidence,'home')
  &&!(values['native-input-p2-lifecycle-late']===true&&values['native-input-p2-lifecycle-dispose']===true)
  &&Object.keys(values).every(key=>['native-input-p2-lifecycle','native-input-p2-lifecycle-late','native-input-p2-lifecycle-dispose','native-input-p2','native-input-p3','no-model','data-scope'].includes(key)),
 '--native-input-p2-lifecycle local mode requires one isolated macOS arm64 no-model native family, exact data/HOME and no mixed operation');
 return true;
}
