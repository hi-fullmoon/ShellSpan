import {expect,it} from 'vitest';
import {nativeByteBoundarySource,matchesNativeByteBoundary,nativeByteBoundaryJson,selectNativeBoundaryModel,matchesNativeByteBoundaryOriginal,nativeByteBoundaryGoal} from './native-byte-boundary-plan';
const token='00000000-0000-4000-8000-000000000001';
it('keeps the original background field explicit and rejects normalization before approval',()=>{
 const source=nativeByteBoundarySource(token,8192),args={command:source,background:false,timeoutMs:15000};
 expect(matchesNativeByteBoundaryOriginal(args,source)).toBe(true);
 expect(matchesNativeByteBoundaryOriginal({command:source,timeoutMs:15000},source)).toBe(false);
 for(const command of [source.normalize('NFC'),source.replace(/\n/g,'\r\n'),source.replace('\t',''),source.replace('👩🏽‍💻','👩‍💻')])expect(matchesNativeByteBoundaryOriginal({...args,command},source)).toBe(false);
});
it('makes Unicode and mixed-ending preservation explicit without changing the selected source',()=>{
 for(const bytes of [8192,8193] as const){const source=nativeByteBoundarySource(token,bytes),goal=nativeByteBoundaryGoal(source,bytes),json=goal.split('~~~json\n')[1].split('\n~~~')[0],args=JSON.parse(json);expect(args.command).toBe(source);expect(new TextEncoder().encode(args.command)).toHaveLength(bytes);expect(goal).toContain('CR count=1,LF count=126,Tab count=1');expect(goal).toContain('must NOT become U+00E9');expect(goal).toContain('U+1F469,U+1F3FD,U+200D,U+1F4BB');}
 expect(()=>nativeByteBoundaryGoal('changed',8192)).toThrow('unchanged byte-exact');
});
it('constructs exact UTF8 byte boundaries with real CRLF,Tab and graphemes',()=>{
 for(const bytes of [8192,8193] as const){const source=nativeByteBoundarySource(token,bytes);expect(new TextEncoder().encode(source)).toHaveLength(bytes);expect(source.length).toBeLessThan(bytes);expect(source).toContain('中文 e\u0301 👩🏽‍💻 !\t\r\n');expect(source).toContain('boundary-'+token+'.txt');expect(source.endsWith("Write-Output ('APP_BOUNDARY_'+'OK')")).toBe(true);}
});
it('approves only the complete unchanged source and foreground timeout',()=>{
 const source=nativeByteBoundarySource(token,8192),args={command:source,background:false,timeoutMs:15000};
 expect(matchesNativeByteBoundary(args,source)).toBe(true);
 for(const changed of [{command:source+'a'},{command:source.replace('\r\n','\n')},{background:true},{timeoutMs:5000},{lifecycleTrust:'directRequired'}])expect(matchesNativeByteBoundary({...args,...changed},source)).toBe(false);
});
it('represents the same bytes as explicit ASCII JSON without Unicode or newline normalization',()=>{
 const source=nativeByteBoundarySource(token,8192),json=nativeByteBoundaryJson(source);
 expect(/[^\x20-\x7e]/.test(json)).toBe(false);expect(json).toContain('e\\u0301');expect(json).toContain('\\t\\r\\n');expect(JSON.parse(json)).toBe(source);
});
it('selects only an existing route/model without changing the default',()=>{
 const snapshot={routes:[{id:'existing',models:{first:{},second:{}}}],defaultSelection:{routeId:'existing',modelId:'first'}};
 expect(selectNativeBoundaryModel(snapshot,'existing','second')).toEqual({routeId:'existing',modelId:'second'});
 expect(snapshot.defaultSelection.modelId).toBe('first');
 expect(selectNativeBoundaryModel(snapshot,null,null)).toBe(snapshot.defaultSelection);
 for(const [route,model]of [['other','second'],['existing','unknown'],['existing',null]] as const)expect(()=>selectNativeBoundaryModel(snapshot,route,model)).toThrow();
});
