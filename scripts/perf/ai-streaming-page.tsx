import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MessageScroller, Message } from '@/components/ai/chat-primitives';
import { AssistantMessageContent } from '@/components/ai/assistant-message-content';
import { AiConversationNodeSeat } from '@/components/ai/workspace/ai-conversation-node-seat';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import type { AiScrollAnchor } from '@/lib/ai/panel-route';
import { initI18n } from '@/locales';
import { SubmissionCheck } from './ai-submission-check';
import { writeImageDraft } from '@/lib/ai/image-drafts';
import type { AgentImageUpload } from '@/types/agent-image';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

// Browser integration surface: real components, native layout/observers and
// repository Markdown supplied by the runner. No transport or geometry stubs.
const root = createRoot(document.getElementById('root')!);
let revision = 0;
let history = '';
let answer = '';
let saved: AiScrollAnchor | undefined;
let initialAnchor: AiScrollAnchor | undefined;
let process: AiConversationNodeOf<'turnProcess'> | undefined;
let followFromStart = false;

function Row({ id, children }: {
  id: string;
  children: React.ReactNode;
  scrollAnchor?: boolean;
  scrollItemId: string;
  scrollItemClassName?: string;
}) {
  return <div data-ai-node-key={id}>{children}</div>;
}

function render() {
  flushSync(() => root.render(
    <main className="ai-panel-shell h-dvh w-full min-w-0" data-ai-scope="workbench">
      <MessageScroller key={revision} followKey={String(answer.length)} turnAnchorKey={followFromStart ? undefined : 'user'}
        initialAnchor={initialAnchor} onAnchorChange={(anchor) => { saved = anchor; }}>
        <Row key="history" id="history" scrollItemId="history">
          <AssistantMessageContent blocks={[{ type: 'text', text: history }]} streaming={false} />
        </Row>
        <Row key="user" id="user" scrollItemId="user" scrollAnchor
          scrollItemClassName="[content-visibility:visible]">
          <Message role="user">README.md</Message>
        </Row>
        <Row key="answer" id="answer" scrollItemId="answer"
          scrollItemClassName="[content-visibility:visible]">
          <AssistantMessageContent blocks={[{ type: 'text', text: answer }]} streaming />
        </Row>
        {process && <Row key="process" id="process" scrollItemId="process"
          scrollItemClassName="[content-visibility:visible]">
          <AiConversationNodeSeat node={process} />
        </Row>}
      </MessageScroller>
    </main>,
  ));
}

await initI18n('en-US');
Object.assign(window, {
  streamingCheck: {
    async submissionCase(queue: boolean, image?: AgentImageUpload) {
      revision += 1;
      const imageOwner = image ? `submission-check:${crypto.randomUUID()}` : undefined;
      if (imageOwner && image) await writeImageDraft({ owner: imageOwner, revision: 1, text: '', images: [image] }, 0);
      flushSync(() => root.render(<SubmissionCheck key={revision} queue={queue} history={history} imageOwner={imageOwner} />));
    },
    anchor() { return saved; },
    reset(content: string) {
      revision += 1;
      followFromStart = false;
      history = content;
      answer = '';
      initialAnchor = undefined;
      saved = undefined;
      process = undefined;
      render();
    },
    resetFollowing(content: string) {
      revision += 1;
      followFromStart = true;
      history = content;
      answer = '';
      initialAnchor = undefined;
      saved = undefined;
      process = undefined;
      render();
    },
    append(content: string) { answer += content; render(); },
    replaceAnswer(content: string) { answer = content; render(); },
    reopen() { initialAnchor = saved; revision += 1; render(); },
    processEventCount(scenario: 'multiple-tools' | 'retry-success') {
      return agentSessionBaselineScenarios[scenario].events.length;
    },
    replayProcess(scenario: 'multiple-tools' | 'retry-success', length: number) {
      process = projectAgentChatNodes(agentSessionBaselineScenarios[scenario].events.slice(0, length))
        .find((node): node is AiConversationNodeOf<'turnProcess'> => node.kind === 'turnProcess');
      render();
    },
  },
});
