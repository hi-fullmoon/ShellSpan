import {quotePosixFileSource} from './native-file-chain-posix';
export function macHumanScope(selection:string|null){
 if(selection==='human-selection-zsh')return{caseScope:'selection-supplement',steps:[5,6]} as const;
 if(selection==='human-copy-zsh'||selection==='human-copy-bash')return{caseScope:'copy-supplement',steps:[7,8,9]} as const;
 if(selection==='human-zsh'||selection==='human-bash')return{caseScope:'full-nine-step',steps:[1,2,3,4,5,6,7,8,9]} as const;
 throw Error('Exact isolated human selection required');
}
export function macHumanPlan(token:string){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token))throw Error('Exact human case identity required');
 const prefix='HUMAN_'+token.slice(0,8)+'_';
 const input=(index:number,value:string,expectedValue:string)=>({source:`printf '%s%s\\n' ${prefix+index+'_'} ${quotePosixFileSource(value)}`,expected:prefix+index+'_'+expectedValue+'\r\n'});
 const ascii=input(1,'EDIT_BAD','EDIT_BAK'),ime={source:`printf '%s%s\\n' ${prefix+'2_'} 'IME_`,expected:prefix+'2_IME_中文\r\n'};
 const unicodeValue='NFD_e\u0301_👩🏽‍💻_X',unicode={source:`printf '%s%s\\n' ${prefix+'3_'} ${unicodeValue}`,expected:prefix+'3_'+unicodeValue.slice(0,-1)+'K\r\n'};
 const asciiSample='SELECT_ASCII alpha  beta END_ASCII',unicodeRaw='SELECT_UNICODE A\tB  中文 e\u0301 👩🏽‍💻 ! END_UNICODE',unicodeCopy=unicodeRaw.replace('\t','        '),soft='SOFT_START '+Array.from({length:40},(_,i)=>'word'+String(i).padStart(2,'0')).join(' ')+' SOFT_END',hard='HARD_FIRST alpha\nHARD_SECOND beta';
 const nativeRaw='NATIVE_UNICODE A\tB  中文 e\u0301 👩🏽‍💻 ! END_NATIVE',nativeCopy=nativeRaw.replace('\t','        ');
 // Both ASCII prefixes occupy exactly 16 columns before Tab: standard stops
 // serialize the actual displayed Tab as eight spaces. Source bytes stay Tab.
 return{prefix,inputs:[ascii,ime,unicode],asciiSample,unicodeRaw,unicodeCopy,soft,hard,nativeRaw,nativeCopy,payload:[asciiSample,unicodeRaw,soft,hard,'HUMAN_SAMPLES_READY'].join('\n')};
}
