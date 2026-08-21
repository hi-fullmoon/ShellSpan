export interface AssistantContentParts {
  answer: string;
  reasoning: string;
  reasoningComplete: boolean;
}

const THINK_BLOCK_PATTERN = /<think>([\s\S]*?)(<\/think>|$)/gi;

export function parseAssistantContent(content: string): AssistantContentParts {
  const answerParts: string[] = [];
  const reasoningParts: string[] = [];
  let cursor = 0;
  let foundReasoning = false;
  let reasoningComplete = true;

  for (const match of content.matchAll(THINK_BLOCK_PATTERN)) {
    foundReasoning = true;
    const index = match.index ?? cursor;
    answerParts.push(content.slice(cursor, index));
    reasoningParts.push(match[1]);

    if (!match[2]) {
      reasoningComplete = false;
      cursor = content.length;
      break;
    }
    cursor = index + match[0].length;
  }

  if (!foundReasoning) {
    return { answer: content, reasoning: '', reasoningComplete: true };
  }

  answerParts.push(content.slice(cursor));
  return {
    answer: answerParts.join('').trim(),
    reasoning: reasoningParts.join('\n\n').trim(),
    reasoningComplete,
  };
}
