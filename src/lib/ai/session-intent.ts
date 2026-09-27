/** Display metadata must not turn an attachment action into a user instruction. */
export function initialSessionIntent(content: string, imageOnlyGoal: string): {
  goal: string;
  successCriteria: string[];
} {
  const text = content.trim();
  return {
    goal: text || imageOnlyGoal,
    // Native tool policy bounds each criterion to 2 KiB.
    successCriteria: text ? [text.length > 512 ? `${text.slice(0, 511)}…` : text] : [],
  };
}
