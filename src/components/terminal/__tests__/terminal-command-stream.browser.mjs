// These suites replay checked-in genuine PTY packets, including the original
// history jump failure. They inspect public buffer, native selection/search,
// cursor/reflow and DOM/WebGL in Chromium/WebKit without source projection.
// No old shell capture producer or frozen executable is invoked here.
await import('../../../lib/terminal/__tests__/native-input-display.browser.mjs');
await import('../../../lib/terminal/__tests__/native-selection-reflow.browser.mjs');
// Mandatory fresh NIP geometry captures; missing read timing fails rather than
// reviving the old producer. Retains >3 visible states and >500ms assertions.
await import('../../../../scripts/native-input-p2/browser.mjs');
