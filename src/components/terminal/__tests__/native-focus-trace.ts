// Passive facts for the isolated P3 fixture. No text, input or focus mutation.
export interface FocusTraceContext {
  monitoring: boolean;
  stage: string;
  section: string;
  activeSessionId: string | null;
  expectedSessionId: string | null;
  focusEnabled: boolean;
  focusTarget: string | null;
  draftLength: number;
  draftMatches: boolean;
}

export interface FocusLeaseFact {
  sessionId: string;
  agentSessionId: string;
  operationId: string;
  state: string;
  commandPhase?: string;
}

export interface FocusRuntimeFact {
  type: string;
  seq: number;
  backendUnixMs: number;
}

export type FocusCheckTrigger = 'armed' | 'runtime' | 'lease' | 'store-app'
  | 'store-terminal' | 'store-focus' | 'focusin' | 'after-tools' | 'before-review';

interface Options {
  editor: () => HTMLElement | null;
  context: () => FocusTraceContext;
  onLimit: () => void;
  maxEntries?: number;
  maxBytes?: number;
}

interface NodeFact {
  id: number;
  kind: 'window' | 'document' | 'element' | 'other';
  tag?: string;
  role?: string | null;
  composer?: boolean;
  terminal?: boolean;
  connected?: boolean;
}

interface TraceData {
  related?: NodeFact;
  target?: NodeFact;
  trusted?: boolean;
  browserTimeMs?: number;
  attribute?: string;
  oldFlag?: string | boolean | null;
  removedEditor?: boolean;
  addedEditor?: boolean;
  nativeFocused?: boolean;
  lease?: FocusLeaseFact;
  runtime?: FocusRuntimeFact;
  trigger?: FocusCheckTrigger;
}

export function createNativeFocusTrace(options: Options) {
  const maxEntries = options.maxEntries ?? 2048;
  const maxBytes = options.maxBytes ?? 384 * 1024;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 2048
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 384 * 1024) {
    throw new Error('Invalid passive focus diagnostic limits');
  }
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  let stopped = false;
  let overflow = false;
  let serializedBytes = 0;
  let nativeFocused: boolean | null = null;
  let runtime: FocusRuntimeFact | undefined;
  let lease: FocusLeaseFact | undefined;
  let finishedStage: 'contract-complete' | 'failure-before-cleanup' | undefined;
  const states: ReturnType<typeof capture>[] = [];
  const stateIds = new Map<string, number>();
  const entries: { index: number; kind: string; clientMs: number; clientUnixMs: number; state: number; data?: TraceData }[] = [];
  let firstViolation: { entry: number; clientMs: number; clientUnixMs: number; trigger: FocusCheckTrigger; snapshot: ReturnType<typeof capture> } | undefined;
  let previousAncestors = new Set<Node>();
  const encoder = new TextEncoder();
  const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
  const id = (value: object) => {
    let result = ids.get(value);
    if (result === undefined) { result = nextId++; ids.set(value, result); }
    return result;
  };
  function describe(value: EventTarget | null): NodeFact | undefined {
    if (!value) return undefined;
    if (value === window) return { id: id(value), kind: 'window' };
    if (value === document) return { id: id(value), kind: 'document' };
    if (!(value instanceof Element)) return { id: id(value), kind: 'other' };
    const rawRole = value.getAttribute('role');
    const role = rawRole === null ? null : ['textbox', 'button', 'dialog', 'alertdialog', 'menu', 'menuitem',
      'listbox', 'option', 'tab', 'tabpanel', 'link', 'combobox', 'application', 'document', 'region', 'none', 'presentation'].includes(rawRole) ? rawRole : 'other';
    return { id: id(value), kind: 'element', tag: value.tagName, role,
      composer: value.matches('[data-composer-editor]'), terminal: !!value.closest('.xterm'), connected: value.isConnected };
  }
  function light() {
    const editor = options.editor();
    return { documentFocused: document.hasFocus(), visibility: document.visibilityState,
      active: describe(document.activeElement), editor: describe(editor),
      editable: editor?.isContentEditable ?? null, contentEditable: editor?.contentEditable ?? null,
      ariaDisabled: editor?.getAttribute('aria-disabled') === 'true', nativeFocused };
  }
  function capture() {
    const editor = options.editor(), ancestors = [];
    const nodes = new Set<Node>();
    for (let node = editor; node; node = node.parentElement) {
      if (ancestors.length === 64) { limit(); break; }
      nodes.add(node);
      const style = getComputedStyle(node);
      ancestors.push({ id: id(node), tag: node.tagName, hidden: node.hidden, inert: node.inert,
        displayNone: style.display === 'none', visibilityHidden: style.visibility === 'hidden' });
    }
    if (editor?.isConnected) previousAncestors = nodes;
    const context = options.context();
    return { ...light(), context: {
      monitoring: context.monitoring, stage: context.stage, section: context.section,
      activeSessionId: context.activeSessionId, expectedSessionId: context.expectedSessionId,
      focusEnabled: context.focusEnabled, focusTarget: context.focusTarget,
      draftLength: context.draftLength, draftMatches: context.draftMatches,
    }, ancestors };
  }
  function limit() {
    if (overflow) return;
    overflow = true;
    options.onLimit();
  }
  function record(kind: string, data?: TraceData) {
    if (stopped || overflow) return;
    const snapshot = capture();
    if (overflow) return;
    const key = JSON.stringify(snapshot);
    const existing = stateIds.get(key), state = existing ?? states.length;
    const entry = { index: entries.length, kind, clientMs: performance.now(), clientUnixMs: Date.now(), state, data };
    const size = bytes(entry) + (existing === undefined ? bytes(snapshot) : 0);
    if (entries.length >= maxEntries || serializedBytes + size > maxBytes) { limit(); return; }
    if (existing === undefined) { states.push(snapshot); stateIds.set(key, state); }
    entries.push(entry); serializedBytes += size;
  }
  const eventFact = (event: Event): TraceData => ({ target: describe(event.target), trusted: event.isTrusted,
    browserTimeMs: event.timeStamp, ...(event instanceof FocusEvent ? { related: describe(event.relatedTarget) } : {}) });
  const dom = (event: Event) => record(`dom:${event.type}`, eventFact(event));
  const win = (event: Event) => record(`window:${event.type}`, eventFact(event));
  for (const type of ['focusin', 'focusout', 'pointerdown']) document.addEventListener(type, dom, true);
  document.addEventListener('visibilitychange', dom, true);
  for (const type of ['focus', 'blur', 'resize']) window.addEventListener(type, win);
  const observer = new MutationObserver(mutations => {
    const editor = options.editor();
    if (!editor || stopped || overflow) return;
    for (const mutation of mutations) {
      const contains = (node: Node) => node === editor || node.contains(editor);
      const removedEditor = [...mutation.removedNodes].some(contains);
      const addedEditor = [...mutation.addedNodes].some(contains);
      if (mutation.target !== editor && !mutation.target.contains(editor)
        && !previousAncestors.has(mutation.target) && !removedEditor && !addedEditor) continue;
      const attribute = mutation.attributeName;
      const oldFlag = attribute === 'contenteditable' || attribute === 'aria-disabled'
        ? (['true', 'false', 'plaintext-only', 'inherit'].includes(mutation.oldValue ?? '') ? mutation.oldValue : null)
        : attribute === 'hidden' || attribute === 'inert' ? mutation.oldValue !== null : undefined;
      record(`mutation:${mutation.type}`, { target: describe(mutation.target), attribute: attribute ?? undefined,
        oldFlag, removedEditor, addedEditor });
      if (overflow) break;
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'contenteditable', 'aria-disabled'] });
  let lastLight = JSON.stringify(light());
  let frame = 0;
  const sample = () => {
    if (stopped || overflow) return;
    const next = JSON.stringify(light());
    if (next !== lastLight) { record('frame:focus-state-change'); lastLight = next; }
    frame = requestAnimationFrame(sample);
  };
  frame = requestAnimationFrame(sample);
  record('installed');
  function dispose() {
    if (stopped) return;
    stopped = true; cancelAnimationFrame(frame); observer.disconnect();
    for (const type of ['focusin', 'focusout', 'pointerdown']) document.removeEventListener(type, dom, true);
    document.removeEventListener('visibilitychange', dom, true);
    for (const type of ['focus', 'blur', 'resize']) window.removeEventListener(type, win);
  }
  return {
    check(trigger: FocusCheckTrigger) { record('check', { trigger, runtime, lease }); },
    violate(trigger: FocusCheckTrigger) {
      if (stopped || firstViolation) return;
      firstViolation = { entry: entries.length, clientMs: performance.now(), clientUnixMs: Date.now(), trigger, snapshot: capture() };
      record('first-violation', { trigger, runtime, lease });
    },
    runtime(value: FocusRuntimeFact) {
      runtime = { type: value.type, seq: value.seq, backendUnixMs: value.backendUnixMs };
      record('runtime', { runtime });
    },
    lease(value: FocusLeaseFact) {
      lease = { sessionId: value.sessionId, agentSessionId: value.agentSessionId,
        operationId: value.operationId, state: value.state, commandPhase: value.commandPhase };
      record('lease', { lease });
    },
    nativeFocus(value: boolean) { nativeFocused = value; record('native-window-focus', { nativeFocused: value }); },
    arm() { record('armed'); },
    finish(stage: 'contract-complete' | 'failure-before-cleanup') {
      finishedStage ??= stage;
      record(finishedStage); dispose();
      return { version: 1, scope: 'passive isolated fixture facts; timestamps denote client observation, not causal attribution',
        stage: finishedStage, limits: { maxEntries, maxBytes }, serializedBytes, overflow, firstViolation, states, entries };
    },
    dispose,
  };
}

export type NativeFocusTrace = ReturnType<typeof createNativeFocusTrace>;
export type NativeFocusTraceEvidence = ReturnType<NativeFocusTrace['finish']>;
