import {expect,it} from 'vitest';import {nativeCaptureError} from './native-capture-error';
it('keeps actual bounded refusal diagnostics without inferring a foreground cause',()=>{
 expect(nativeCaptureError(500,'Physical window DPI context unavailable')).toContain('HTTP 500): Physical window DPI context unavailable');
 expect(nativeCaptureError(503,'x'.repeat(5000))).toHaveLength(nativeCaptureError(503,'').length+4096);
});
