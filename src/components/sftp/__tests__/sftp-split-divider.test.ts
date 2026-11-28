import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('SFTP split divider hairline contract', () => {
  const baseCss = readFileSync('src/styles/base.css', 'utf8');

  it('overlaps the preceding pane edge so the translucent divider composites over pane surfaces', () => {
    expect(baseCss).toMatch(
      /\.sftp-split-pane\s*>\s*\[data-slot='split-pane-divider'\]\s*\{\s*margin-left:\s*-1px;\s*\}/,
    );
  });

  it('draws a single-physical-pixel hairline across scaled and HiDPI resolutions when resting', () => {
    expect(baseCss).toContain('@media (forced-colors: none) and (min-resolution: 1.25dppx)');
    expect(baseCss).toContain('--sftp-divider-stop: calc(100% / 1.25);');
    expect(baseCss).toContain('@media (forced-colors: none) and (min-resolution: 1.5dppx)');
    expect(baseCss).toContain('--sftp-divider-stop: calc(100% / 1.5);');
    expect(baseCss).toContain('@media (forced-colors: none) and (min-resolution: 1.75dppx)');
    expect(baseCss).toContain('--sftp-divider-stop: calc(100% / 1.75);');
    expect(baseCss).toContain('@media (forced-colors: none) and (min-resolution: 2dppx)');
    expect(baseCss).toContain('--sftp-divider-stop: 50%;');
    expect(baseCss).toContain('@media (forced-colors: none) and (min-resolution: 3dppx)');
    expect(baseCss).toContain('--sftp-divider-stop: calc(100% / 3);');
    expect(baseCss).toMatch(
      /linear-gradient\(\s*to right,\s*var\(--app-resize-divider\)\s+0\s+var\(--sftp-divider-stop\),\s*transparent\s+var\(--sftp-divider-stop\)\s*\)/,
    );
  });

  it('keeps the solid focus-visible highlight outside the resting hairline rule', () => {
    expect(baseCss).toMatch(
      /\.sftp-split-pane\s*>\s*\[data-slot='split-pane-divider'\]:focus-visible\s*\{\s*outline:\s*none;\s*background-color:\s*var\(--ring\);\s*\}/,
    );
    expect(baseCss).toContain(".sftp-split-pane > [data-slot='split-pane-divider']:not(:focus-visible)");
  });
});
