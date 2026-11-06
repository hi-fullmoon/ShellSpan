export function nativeByteBoundarySource(token:string,bytes:8192|8193):string{
 if(!/^[a-f0-9-]{36}$/.test(token))throw Error('Owned boundary token required');
 const prefix='# B01 中文 e\u0301 👩🏽‍💻 !\t\r\n';
 const body=`[IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'boundary-${token}.txt'),'ONCE'+[Environment]::NewLine); Write-Output ('APP_BOUNDARY_'+'OK')`;
 const encoder=new TextEncoder();let remaining=bytes-encoder.encode(prefix+body).length;
 const lines:string[]=[];let line=0;
 while(remaining>=64){lines.push(`#L${String(line++).padStart(3,'0')} ${'a'.repeat(57)}\n`);remaining-=64;}
 if(remaining>0){if(remaining===1){lines[lines.length-1]=lines[lines.length-1].slice(0,-1)+'a\n';}else lines.push('#'+'a'.repeat(remaining-2)+'\n');}
 const source=prefix+lines.join('')+body;
 if(encoder.encode(source).length!==bytes)throw Error('Boundary construction is not byte exact');
 return source;
}
export function matchesNativeByteBoundary(value:unknown,source:string):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const args=value as Record<string,unknown>;
 return Object.keys(args).every(key=>['command','background','timeoutMs','explanation'].includes(key))
  &&args.command===source&&(args.background===undefined||args.background===false)&&args.timeoutMs===15000;
}
export function nativeByteBoundaryJson(source:string):string{
 return JSON.stringify(source).replace(/[^\x20-\x7e]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
}
export function matchesNativeByteBoundaryOriginal(value:unknown,source:string):boolean{
 return matchesNativeByteBoundary(value,source)&&(value as Record<string,unknown>).background===false;
}
export function nativeByteBoundaryGoal(source:string,bytes:8192|8193):string{
 if(new TextEncoder().encode(source).length!==bytes)throw Error('Boundary goal requires the unchanged byte-exact source');
 const argumentObject='{"command":'+nativeByteBoundaryJson(source)+',"background":false,"timeoutMs":15000,"explanation":"Verify the exact native source byte boundary."}';
 const counts={cr:(source.match(/\r/g)??[]).length,lf:(source.match(/\n/g)??[]).length,tab:(source.match(/\t/g)??[]).length};
 return `Call run_terminal_command exactly ONCE using the complete JSON object below as its tool arguments. Copy the fields directly;command is decoded ONCE by normal JSON parsing,not wrapped in another quoted string. Preserve every escape,code unit and numbered line. Do not reconstruct the text from counts. This fixture deliberately mixes line endings:after JSON decoding,CR count=${counts.cr},LF count=${counts.lf},Tab count=${counts.tab}. Windows is NOT a reason to convert LF to CRLF,duplicate CR or remove Tab. The decomposed e followed by U+0301 must NOT become U+00E9. The emoji sequence U+1F469,U+1F3FD,U+200D,U+1F4BB and all exact JSON escape digits must remain unchanged. No Unicode normalization,substitution,shortening,repair,retry,Direct or other tools. The command decodes to exactly ${bytes} UTF-8 bytes;8193 deliberately tests backend refusal. Then stop.\n~~~json\n${argumentObject}\n~~~`;
}
export function selectNativeBoundaryModel(
 snapshot:{routes:readonly {id:string;models?:Record<string,unknown>;modelOverrides?:Record<string,unknown>}[];defaultSelection?:{routeId:string;modelId:string;reasoningEffort?:string}},
 route:string|null,model:string|null,
):{routeId:string;modelId:string;reasoningEffort?:string}{
 if(!!route!==!!model)throw Error('Boundary route/model pair required');
 if(!route||!model){if(!snapshot.defaultSelection)throw Error('Supplied model missing');return snapshot.defaultSelection;}
 const found=snapshot.routes.find(item=>item.id===route);
 if(!found||!(found.models?.[model]??found.modelOverrides?.[model]))throw Error('Boundary model is not configured');
 return {routeId:route,modelId:model};
}
