import { SearchAddon } from '@xterm/addon-search';
import type { IDisposable, Terminal } from '@xterm/xterm';

export class TerminalSearchAddon extends SearchAddon {
  private terminal?: Terminal;
  private selectionListener?: IDisposable;
  private ownsSelection = false;
  private selecting = false;

  get selectingMatch(): boolean {
    return this.selecting;
  }

  override activate(terminal: Terminal): void {
    super.activate(terminal);
    this.terminal = terminal;
    this.selectionListener = terminal.onSelectionChange(() => {
      if (!this.selecting) this.ownsSelection = false;
    });
  }

  override dispose(): void {
    this.selectionListener?.dispose();
    this.terminal = undefined;
    super.dispose();
  }

  override findNext(...args: Parameters<SearchAddon['findNext']>): boolean {
    return this.selectMatch(() => super.findNext(...args));
  }

  override findPrevious(...args: Parameters<SearchAddon['findPrevious']>): boolean {
    // A scheduled refresh can outlive clearDecorations. Forward the addon's
    // internal no-scroll argument when a refresh still has a term to search.
    return Boolean(args[0]) && this.selectMatch(() => super.findPrevious(...args));
  }

  clearSearch(): void {
    this.clearDecorations();
    if (this.ownsSelection) this.terminal?.clearSelection();
    this.ownsSelection = false;
  }

  private selectMatch(search: () => boolean): boolean {
    this.selecting = true;
    try {
      this.ownsSelection = search();
      return this.ownsSelection;
    } finally {
      this.selecting = false;
    }
  }
}
