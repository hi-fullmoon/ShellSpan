const DEFAULT_MAX_ENTRIES = 256;

export class AppActionDedupeSet {
  private readonly seen = new Set<string>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  claim(actionId: string | undefined): boolean {
    if (!actionId) return true;
    if (this.seen.has(actionId)) return false;
    this.seen.add(actionId);
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  has(actionId: string): boolean {
    return this.seen.has(actionId);
  }

  clear(): void {
    this.seen.clear();
  }
}

export const liveAppActionDedupe = new AppActionDedupeSet();
