import {expect,it} from 'vitest';
import {isManualSelection,manualPointerRow,matchesKnownClipboard,nativeDisplaySamples} from './native-display-manual-plan';
it('requires exact Unicode/spacing, a trusted terminal gesture and the declared direction',()=>{
 const forward={trusted:true,startX:10,startY:10,endX:100,endY:10,startRow:0,endRow:0};
 expect(isManualSelection(nativeDisplaySamples.unicode,nativeDisplaySamples.unicode,forward,'forward')).toBe(true);
 expect(isManualSelection(nativeDisplaySamples.unicode,nativeDisplaySamples.unicode.normalize('NFC'),forward,'forward')).toBe(false);
 expect(isManualSelection('a  b','a b',forward,'forward')).toBe(false);
 expect(isManualSelection('known','known',{...forward,trusted:false},'forward')).toBe(false);
 expect(isManualSelection('known','known',forward,'reverse')).toBe(false);
 expect(isManualSelection('known','known',undefined,'forward')).toBe(false);
 expect(isManualSelection('known','known',{...forward,startX:100,endX:10},'reverse')).toBe(true);
});
it('uses actual terminal rows for direction despite vertical jitter within one row',()=>{
 const gesture={trusted:true,startX:10,startY:110,endX:100,endY:108,startRow:0,endRow:0};
 expect(isManualSelection('known','known',gesture,'forward')).toBe(true);
 expect(isManualSelection('known','known',{...gesture,startX:100,endX:10,endY:112},'reverse')).toBe(true);
 expect(isManualSelection('known','known',{...gesture,startX:100,endX:10,startRow:0,endRow:1,endY:130},'forward')).toBe(true);
 expect(isManualSelection('known','known',{...gesture,startRow:1,endRow:0,startY:130},'reverse')).toBe(true);
 expect(isManualSelection('known','known',{...gesture,startRow:NaN},'forward')).toBe(false);
});
it('maps only real visible screen geometry to rows',()=>{
 expect(manualPointerRow(108,100,400,20)).toBe(0);
 expect(manualPointerRow(112,100,400,20)).toBe(0);
 expect(manualPointerRow(120,100,400,20)).toBe(1);
 expect(manualPointerRow(499,100,400,20)).toBe(19);
 for(const y of [99,500,NaN])expect(manualPointerRow(y,100,400,20)).toBeNull();
 expect(manualPointerRow(110,100,0,20)).toBeNull();
 expect(manualPointerRow(110,100,400,0)).toBeNull();
});
it('permits only exact known clipboard text and platform hard-line endings',()=>{
 expect(matchesKnownClipboard(nativeDisplaySamples.hard,nativeDisplaySamples.hard.replace(/\n/g,'\r\n'))).toBe('windows-newlines');
 expect(matchesKnownClipboard(nativeDisplaySamples.soft,nativeDisplaySamples.soft)).toBe('exact');
 expect(matchesKnownClipboard(nativeDisplaySamples.soft,nativeDisplaySamples.soft.replace('word10','word10\n'))).toBeNull();
 expect(matchesKnownClipboard(nativeDisplaySamples.unicode,nativeDisplaySamples.unicode.normalize('NFC'))).toBeNull();
 expect(matchesKnownClipboard('known','unrelated clipboard')).toBeNull();
});
