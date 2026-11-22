import type { AiConversationNode } from './conversation-node';
import { decodeDocumentMessage } from './document-message';

export interface ConversationExportOptions {
  readonly title: string;
  readonly nodes: readonly AiConversationNode[];
  readonly userLabel: string;
  readonly assistantLabel: string;
}

/** Export only visible durable human/assistant messages as clean Markdown. */
export function formatConversationMarkdown({
  title,
  nodes,
  userLabel,
  assistantLabel,
}: ConversationExportOptions): string {
  const sections: string[] = [];
  const heading = title.trim();
  if (heading) sections.push(`# ${heading}`);

  const visit = (items: readonly AiConversationNode[]): void => {
    for (const node of items) {
      if (node.kind === 'turnProcess') {
        visit(node.children);
        continue;
      }
      if (node.kind === 'userMessage' && node.delivery === 'committed') {
        const message = decodeDocumentMessage(node.content);
        const text = message.text.trim();
        if (text) sections.push(`## ${userLabel}\n\n${text}`);
        continue;
      }
      if (node.kind === 'assistantMessage') {
        const text = node.blocks
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('')
          .trim();
        if (text) sections.push(`## ${assistantLabel}\n\n${text}`);
      }
    }
  };

  visit(nodes);
  return sections.length > (heading ? 1 : 0) ? `${sections.join('\n\n')}\n` : '';
}

export function hasExportableConversationMessages(nodes: readonly AiConversationNode[]): boolean {
  for (const node of nodes) {
    if (node.kind === 'turnProcess') {
      if (hasExportableConversationMessages(node.children)) return true;
      continue;
    }
    if (node.kind === 'userMessage' && node.delivery === 'committed') {
      if (decodeDocumentMessage(node.content).text.trim()) return true;
    }
    if (node.kind === 'assistantMessage') {
      if (node.blocks.some((block) => block.type === 'text' && block.text.trim() !== '')) return true;
    }
  }
  return false;
}

export function exportConversationFileName(title: string): string {
  const sanitized = title
    .replace(/[\u0000-\u001f/\\:*?"<>|]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
  return `${sanitized || 'shellspan-conversation'}.md`;
}
