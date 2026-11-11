import {quotePosixFileSource} from './native-file-chain-posix';

// Freeze named operations before execution. A failing run keeps its incomplete
// records; it cannot shrink this list to turn itself into a passing run.
export const macDailyExpectedRecords={
 native:['ready','ordinary-0','ordinary-1','nfc-tail-edit','ordinary-2','nfd-tail-edit','ordinary-3','ordinary-4','ordinary-5','ordinary-6','tab-completion','ordinary-7','ordinary-7','history-search','unicode-cursor-before','unicode-cursor-returned','ordinary-8','tui-enter','tui-edit','tui-navigation','ordinary-9','tui-exit','draft-440x320','draft-360x580','draft-1100x320','draft-1100x650','ordinary-10','parked-initial','parked-new-output','parked-440','parked-360','parked-1100','follow-new-output','search-history','transport-end'],
 raw:['ready','raw-ordinary','tui-enter','tui-edit','tui-exit','raw-readonly','raw-preparation-false','raw-preparation-true','raw-production-refusal','transport-end'],
 editing:['ready','multiline-before','multiline-first-cursor','multiline-first-edited','multiline-last-cursor','multiline-edited','ordinary-11','completion-expanded','completion-output','printed-output','printed-440x320','printed-360x580','printed-1100x320','printed-1100x650','follow-output','follow-440x320','follow-360x580','follow-1100x320','follow-1100x650','background-draft','background-440x320','background-360x580','background-1100x320','background-1100x650','background-ended','ordinary-12','pump-started','pump-pasted','pump-cancelled','ordinary-13','transport-end'],
 pump:['ready','pump-completion-started','pump-completion-pasted','pump-completion-received','pump-completion-ended','transport-end'],
 toast:['ready','toast-lease-acquired','toast-visible','toast-lease-released','ordinary-14','transport-end'],
} as const;

// One new owned controller runs every original daily operation. Only repeated
// ready/transport cleanup points are shared; the old standalone plans stay intact.
export const macDailyFullExpectedRecords=[
 ...macDailyExpectedRecords.native.slice(0,-1),
 ...macDailyExpectedRecords.editing.slice(1,-1),
 ...macDailyExpectedRecords.pump.slice(1,-1),
 ...macDailyExpectedRecords.toast.slice(1,-1),
 'transport-end',
] as const;

export const macDailyEditingVisualCheckpoints=['multiline-before','multiline-edited','completion-expanded','printed-440x320','printed-1100x650','follow-440x320','follow-1100x650','background-440x320','background-ended','pump-cancelled'] as const;

export function macDailyOutputPlan(token:string,value:string,index:number){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)||!Number.isInteger(index)||index<0||index>32||value.includes('\0'))throw Error('Exact bounded macOS daily output plan required');
 const prefix=`P2HEX_${token.slice(0,8)}_${index}:`;
 return{prefix,source:`printf '%s%s' P2HEX_ ${quotePosixFileSource(token.slice(0,8)+'_'+index+':')}; printf '%s' ${quotePosixFileSource(value)} | /usr/bin/od -An -v -tx1 | /usr/bin/tr -d ' \\n'; printf ':END\\n'`};
}

export function macDailyPasteValues(token:string):readonly(readonly[number,string])[]{
 const padding=4790-new TextEncoder().encode(macDailyOutputPlan(token,'LONG__END',5).source).length;
 if(padding<1)throw Error('Long input prefix exceeds fixed pump case');
 return[[1,'one line  spaces\t\'quoted\' "double"'],[2,'中文 café Å'],[3,'中文 cafe\u0301 A\u030a'],[4,'first line\nsecond\tline\nthird line'],[5,'LONG_'+'x'.repeat(padding)+'_END']];
}

export function macDailySingleOutputPlan(token:string,value:string,index:number){
 const {prefix}=macDailyOutputPlan(token,value,index);
 // Shell job notifications can appear between separate foreground commands.
 // Compute the actual value's hex first, then print its complete bounded frame
 // with one external printf invocation. Never filter the combined PTY stream.
 return{prefix,source:`/usr/bin/printf '%s%s:END\\n' ${quotePosixFileSource(prefix)} "$(printf '%s' ${quotePosixFileSource(value)} | /usr/bin/od -An -v -tx1 | /usr/bin/tr -d ' \\n')"`};
}

export function macDailyTailEditPlan(token:string,value:string,index:number,singleOutput=false){
 const initialValue=value+'_TAIL_X',expectedValue=value+'_TAIL_OK';
 const plan=(singleOutput?macDailySingleOutputPlan:macDailyOutputPlan)(token,initialValue,index),at=plan.source.indexOf(initialValue);
 if(at<0||plan.source.lastIndexOf(initialValue)!==at)throw Error('Unique literal edit value required');
 const suffix=plan.source.slice(at+initialValue.length);
 if(!/^[\x20-\x7e]*$/.test(suffix))throw Error('Tail cursor movement must cross ASCII only');
 return{...plan,initialValue,expectedValue,suffixCharacters:suffix.length};
}

export function macDailyUnicodeEditPlan(token:string){
 const initialValue='中_e\u0301_👩🏽‍💻_后_TAIL',expectedValue='文'+initialValue.slice(1);
 const plan=macDailyOutputPlan(token,initialValue,8),at=plan.source.indexOf(initialValue);
 if(at<0||!/^[\x20-\x7e]*$/.test(plan.source.slice(0,at)))throw Error('Unicode cursor origin must follow an ASCII prefix');
 const traversalKeys=Array.from(initialValue).length+4;
 if(plan.source.length-at-initialValue.length<=traversalKeys)throw Error('Round trip must not clamp at line end');
 return{...plan,initialValue,expectedValue,prefixCharacters:at,traversalKeys};
}

export function macDailyCompletionPlan(token:string){
 macDailyOutputPlan(token,'',0);
 const filename='p2_editing_completion_unique',prefix='COMPLETE_'+token.slice(0,8)+'_中文_e\u0301',value=prefix+'\tEND';
 // Ordinary typed Tab is a completion key. Generate the file's literal Tab
 // through printf, while reserving the actual input Tab for pathname completion.
 return{filename,value,setup:`printf '%s\\t%s\\n' ${quotePosixFileSource(prefix)} END > "$HOME/${filename}"`};
}

export function macDailyPumpCompletionPlan(token:string){
 macDailyOutputPlan(token,'',0);
 const filename='phase2-pump-result',prefix=`P2PUMPDONE_${token.slice(0,8)}:END`,base='LONG_中文_e\u0301_👩🏽‍💻__END';
 const sourceFor=(value:string)=>`p2_long=${quotePosixFileSource(value)}; printf '%s' "$p2_long" > "$HOME/${filename}"; /usr/bin/printf '%s%s:END\\n' P2PUMPDONE_ ${quotePosixFileSource(token.slice(0,8))}; unset p2_long`;
 const padding=4790-new TextEncoder().encode(sourceFor(base)).length;
 if(padding<1)throw Error('Long completion source exceeds the fixed command size');
 const value=base.slice(0,-4)+'x'.repeat(padding)+'_END',source=sourceFor(value);
 return{filename,value,source,sourceByteCount:4790,expectedOutput:prefix+'\r\n'};
}
