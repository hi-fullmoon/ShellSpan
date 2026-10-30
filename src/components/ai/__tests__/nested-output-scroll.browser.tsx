import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MessageScroller } from '../chat-primitives';
import { AssistantMessageContent } from '../assistant-message-content';
import { AiToolExpandedContent } from '../workspace/ai-tool-presentation';
import type { AiToolNode } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import '@/styles/base.css';
import '../styles/styles.css';

interface ScrollSample {
  before: string;
  after: string;
  code: string;
  command: { command: string; output: string; timestamp: string; durationMs: number };
}

const root = createRoot(document.getElementById('root')!);
let sample: ScrollSample;
let variant: 'code' | 'terminal';
let following = false;
let outputFraction = 0.5;
let tail = '';
let running = true;
let revision = 0;
let savedAnchors = 0;
await initI18n('en-US');

function render() {
  const source = variant === 'code' ? sample.code : sample.command.output;
  const lines = source.split('\n');
  const output = lines.slice(0, Math.ceil(lines.length * outputFraction)).join('\n');
  const node: AiToolNode = {
    kind: 'tool', key: 'command', sourceKind: 'agent', sessionId: 'scroll-regression',
    turnId: null, stepId: null, firstSeq: 0, lastSeq: 0, timestamp: sample.command.timestamp,
    callId: 'command', name: 'terminal_execute', nativeName: null, title: null,
    summary: sample.command.command, state: running ? 'running' : 'succeeded', effect: 'readOnly',
    durationMs: sample.command.durationMs,
    detailRef: { kind: 'agentTool', sessionId: 'scroll-regression', callId: 'command' },
    evidenceRefs: [], input: { command: sample.command.command }, output,
    error: null, target: null, idempotency: 'yes', approval: null,
  };
  flushSync(() => root.render(
    <main className="ai-panel-shell flex h-dvh min-h-0 flex-col" data-ai-scope="workbench">
      <MessageScroller key={revision} generating={running} followKey={`${output.length}:${tail.length}:${running}`}
        initialAnchor={following ? undefined : { nodeKey: 'before', atBottom: false, offset: 0, scrollTop: 0 }}
        onAnchorChange={() => { savedAnchors += 1; }}>
        <div key="before" data-ai-node-key="before"><AssistantMessageContent blocks={[{ type: 'text', text: sample.before }]} streaming={false} /></div>
        <div key="output" data-ai-node-key="output">
          {variant === 'terminal' ? <AiToolExpandedContent node={node} />
            : <AssistantMessageContent blocks={[{ type: 'text', text: `~~~~tsx\n${output}\n~~~~` }]} streaming={false} />}
        </div>
        <div key="after" data-ai-node-key="after">
          <AssistantMessageContent blocks={[{ type: 'text', text: sample.after }]} streaming={false} />
          <div className="whitespace-pre-wrap" data-streamed-tail>{tail}</div>
        </div>
      </MessageScroller>
    </main>,
  ));
}

// Real repository source and command output, with native layout and observers.
Object.assign(window, {
  renderNestedOutput(input: ScrollSample, kind: typeof variant, follow = false) {
    sample = input;
    variant = kind;
    following = follow;
    outputFraction = 0.5;
    tail = '';
    running = true;
    revision += 1;
    render();
  },
  appendNestedOutput() { outputFraction = 1; render(); },
  appendTranscriptOutput() { tail += sample.code; render(); },
  finishNestedOutput() { running = false; render(); },
  savedScrollAnchors() { return savedAnchors; },
});
