export type NativeManualForm = 'nfc' | 'nfd';

export function nativeManualInputPlan(marker:string,form:NativeManualForm='nfc'){
 if(!/^MAC_MANUAL_[a-f0-9]{12}$/.test(marker)||(form!=='nfc'&&form!=='nfd'))throw Error('Exact owned manual form required');
 const accent=form==='nfd'?'e\u0301':'é';
 const expected=`${marker} 中文 ${accent} 👩🏽‍💻 edit=BAD`;
const command = `printf '%s\\n' '${expected}'`;
 return{form,expected,command};
}
