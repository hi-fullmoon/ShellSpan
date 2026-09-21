/** Display-only fallback: preserve the full task goal and all explicit titles. */
export function fallbackSessionTitle(goal: string): string {
  const normalized = goal.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(normalized);
  return characters.length > 48 ? `${characters.slice(0, 47).join('').trimEnd()}…` : normalized;
}
