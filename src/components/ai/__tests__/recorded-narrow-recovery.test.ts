import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const fixture=process.env.SHELLSPAN_STAGE2_NARROW_FIXTURE;
describe.skipIf(!fixture)('actual narrow Wry recovery evidence',()=>{
  const root=resolve(fixture??'.');
  const read=(name:string):Record<string,unknown>=>JSON.parse(readFileSync(join(root,name),'utf8')) as Record<string,unknown>;
  it('keeps both languages and disabled recovery actions inside the real 360 pixel container',()=>{
    for(const locale of ['zh','en']){
      const layout=read(`layout-${locale}-360.json`).recoveryLayout as {
        width:number;documentWidth:number;gate:boolean;buttons:{disabled:boolean;left:number;right:number}[];
      };
      expect(layout.width).toBe(360);expect(layout.documentWidth).toBe(360);expect(layout.gate).toBe(true);
      expect(layout.buttons).toHaveLength(2);expect(layout.buttons[0].disabled).toBe(false);expect(layout.buttons[1].disabled).toBe(true);
      for(const button of layout.buttons){expect(button.left).toBeGreaterThanOrEqual(0);expect(button.right).toBeLessThanOrEqual(layout.width);}
    }
  });
  it('uses the unchanged actual dispatch prefix without issuing new model requests or replaying commands',()=>{
    const report=read('narrow-evidence.json');
    expect(report.passed).toBe(true);expect(report.stage3Allowed).toBe(false);
    const checks=report.checks as Record<string,boolean>;
    expect(checks.exactOriginalPrefix).toBe(true);expect(checks.noNewModelOrCommandReplay).toBe(true);
    expect(checks.keyboardReachesReceipt).toBe(true);expect(checks.ownedPtyTerminalOnly).toBe(true);
  });
});
