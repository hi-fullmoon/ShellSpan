import {afterEach,describe,expect,it} from 'vitest';
import {createNativePackageHost,nativePackageViewport} from './native-package-viewport';

afterEach(() => { document.body.replaceChildren(); });
describe('installed package viewport', () => {
  it('mounts ordinary terminals inside the existing full-height root', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    expect(createNativePackageHost().parentElement).toBe(root);
  });
  it('keeps standalone package pages with no root supported', () => {
    expect(createNativePackageHost().parentElement).toBe(document.body);
  });
  it('refuses an unpainted or offscreen terminal instead of accepting a screenshot file alone', () => {
    const host = createNativePackageHost();
    expect(() => nativePackageViewport(host)).toThrow('outside the actual viewport');
  });
});
