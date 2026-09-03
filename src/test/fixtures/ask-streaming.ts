import type {
  AiChatMessage,
  AiConversation,
  AiStreamEvent,
} from '@/types/ai';

export const ASK_STREAM_REQUEST_ID = 'ask-stream-request';
export const ASK_STREAM_CONVERSATION_ID = 'ask-stream-conversation';

export const askStreamingConversationFixture: AiConversation = {
  id: ASK_STREAM_CONVERSATION_ID,
  startedAt: '2026-09-02T08:00:00.000Z',
  updatedAt: '2026-09-02T08:00:02.000Z',
  title: 'Inspect deployment output',
  archived: false,
  scope: 'workbench',
  host: '',
  port: 0,
  username: '',
};

export const askStreamingEventFixture: readonly AiStreamEvent[] = [
  { type: 'started', requestId: ASK_STREAM_REQUEST_ID },
  { type: 'textDelta', requestId: ASK_STREAM_REQUEST_ID, text: 'Inspecting ' },
  { type: 'textDelta', requestId: ASK_STREAM_REQUEST_ID, text: 'the deployment output.' },
  { type: 'completed', requestId: ASK_STREAM_REQUEST_ID },
];

export const askStreamingUserMessageFixture: AiChatMessage = {
  id: 'ask-stream-user',
  requestId: ASK_STREAM_REQUEST_ID,
  role: 'user',
  content: 'Why did the deployment fail?',
  task: 'ask',
  status: 'completed',
  providerId: 'ollama',
  scope: 'workbench',
  conversationId: ASK_STREAM_CONVERSATION_ID,
};

export const askStreamingMessageFixture: readonly AiChatMessage[] = [
  askStreamingUserMessageFixture,
  {
    id: `assistant-${ASK_STREAM_REQUEST_ID}`,
    requestId: ASK_STREAM_REQUEST_ID,
    role: 'assistant',
    content: 'Inspecting the deployment output.',
    task: 'ask',
    status: 'streaming',
    providerId: 'ollama',
    scope: 'workbench',
    conversationId: ASK_STREAM_CONVERSATION_ID,
  },
];

export const askFailedMessageFixture: readonly AiChatMessage[] = [
  askStreamingUserMessageFixture,
  {
    ...askStreamingMessageFixture[1],
    content: 'The provider disconnected before completion.',
    status: 'failed',
  },
];
