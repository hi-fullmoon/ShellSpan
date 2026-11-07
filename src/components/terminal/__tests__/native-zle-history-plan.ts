// JSON Unicode escapes keep the exact requested code units visible to the
// provider, including decomposed accents and emoji surrogate pairs. This only
// encodes a new user instruction; it never rewrites a model proposal.
export function zleHistoryArgumentJson(value:Readonly<Record<string,unknown>>):string{
 return JSON.stringify(value).replace(/[\u0080-\uffff]/g,character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
}
