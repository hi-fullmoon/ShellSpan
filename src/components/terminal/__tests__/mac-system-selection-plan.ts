import configuration from '../../../../scripts/native-input/acceptance/mac-system-selection-configuration.json';
import {macHumanPlan} from './mac-human-plan';
import {macDisplayOutputCommand} from './native-display-manual-posix';

export type MacSystemSelectionPhase={id:string;label:string;sample:string;direction:'forward'|'reverse';native:boolean;expected:string};

export function macSystemSelectionPlan(token:string){
 const human=macHumanPlan(token),samples:Record<string,string>={ascii:human.asciiSample,unicode:human.unicodeCopy,soft:human.soft,hard:human.hard,native:human.nativeCopy};
 const phases=configuration.steps.map<MacSystemSelectionPhase>(step=>{
  const expected=samples[step.sample];if(expected===undefined||(step.direction!=='forward'&&step.direction!=='reverse'))throw Error('Exact system selection configuration required');
  return{...step,direction:step.direction,expected};
 });
 return{...configuration,phases,sourceSamples:{unicodeRaw:human.unicodeRaw,unicodeCopy:human.unicodeCopy,nativeRaw:human.nativeRaw,nativeCopy:human.nativeCopy},
  initialSource:"printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MA==\\007'; "+macDisplayOutputCommand(human.payload),
  initialMarker:'HUMAN_SAMPLES_READY\r\n',
  nativeSource:"printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\\007'; "+macDisplayOutputCommand(human.nativeRaw),nativeMarker:human.nativeRaw+'\r\n',
  exitModeSource:"printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MA==\\007'; printf '%s%s\\n' SYSTEM_ SELECTION_DONE\r",exitModeMarker:'SYSTEM_SELECTION_DONE\r\n'};
}
