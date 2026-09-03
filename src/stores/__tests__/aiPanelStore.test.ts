import { beforeEach, describe, expect, it } from 'vitest';
import { useAiPanelStore } from '../aiPanelStore';

describe('aiPanelStore', () => {
  beforeEach(() => {
    useAiPanelStore.setState({
      panelOpenBySection: { workbench: false, terminal: false },
    });
  });

  it('opens, closes, and toggles panels independently by section', () => {
    useAiPanelStore.getState().setOpen(true, 'workbench');
    expect(useAiPanelStore.getState().panelOpenBySection).toEqual({
      workbench: true,
      terminal: false,
    });

    useAiPanelStore.getState().toggleOpen('terminal');
    expect(useAiPanelStore.getState().panelOpenBySection).toEqual({
      workbench: true,
      terminal: true,
    });

    useAiPanelStore.getState().setOpen(false);
    expect(useAiPanelStore.getState().panelOpenBySection).toEqual({
      workbench: false,
      terminal: false,
    });
  });
});
