import type { AiConversationNode } from './conversation-node';
import type { AiSessionSummary } from './session-adapter';
import { decodeDocumentMessage } from './document-message';
import { validateDocumentText } from './document-import';

/** Only visible, durable human/assistant text belongs in a referenced chat.
 * System prompts, reasoning, tools and injected skills never cross this boundary. */
export function chatReferenceFile(summary: AiSessionSummary, nodes: readonly AiConversationNode[]): File {
  const messages: { role: 'user' | 'assistant'; text: string }[] = [];
  const visit = (items: readonly AiConversationNode[]) => {
    for (const node of items) {
      if (node.kind === 'turnProcess') visit(node.children);
      else if (node.kind === 'userMessage' && node.delivery === 'committed') {
        const message = decodeDocumentMessage(node.content);
        if (message.text.trim()) messages.push({ role: 'user', text: message.text });
      } else if (node.kind === 'assistantMessage' && node.state !== 'streaming') {
        const text = node.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (text.trim()) messages.push({ role: 'assistant', text });
      }
    }
  };
  visit(nodes);
  if (!messages.length) throw new Error('CHAT_REFERENCE_EMPTY');
  const text = validateDocumentText(JSON.stringify({ title: summary.title, sessionId: summary.id, updatedAt: summary.updatedAt, messages }, null, 2));
  const name = summary.title.replace(/[\u0000-\u001f/\\:*?"<>|]/gu, '_').slice(0, 180).trim() || summary.id;
  return new File([text], `${name}.txt`, { type: 'text/plain' });
}
