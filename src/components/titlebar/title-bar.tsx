import React from 'react';
import { cn } from '@/lib/utils';
import { usePlatform } from '@/hooks/usePlatform';
import { SectionNav } from './section-nav';
import { WindowControls } from './window-controls';
import { MessageCircleQuestionIcon, SquareTerminalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/hooks/useI18n';
import { useFocusStore } from '@/stores/focusStore';
import { FocusControls } from '@/components/focus/focus-controls';

export const TitleBar: React.FC = () => {
  const platform = usePlatform();
  const isMacOS = platform === 'macos';
  const { t } = useI18n();
  const activeSection = useAppStore((state) => state.activeSection);
  const focusEnabled = useFocusStore(state => state.enabled);
  const panelSection = activeSection === 'terminal' ? 'terminal' : 'workbench';
  const aiOpen = useAiPanelStore((state) => (
    activeSection !== 'sftp' && state.panelOpenBySection[panelSection]
  ));
  const toggleAi = useAiPanelStore((state) => state.toggleOpen);
  const aiLabel = activeSection === 'terminal'
    ? t('ai.terminal.toggle')
    : t('ai.workbench.toggle');
  const AiToggleIcon = activeSection === 'terminal'
    ? SquareTerminalIcon
    : MessageCircleQuestionIcon;

  return (
    <div
      className={cn(
        'flex h-10 w-full shrink-0 items-center justify-between border-b border-app-border/50 bg-app-surface/90 backdrop-blur-sm',
        isMacOS ? 'pl-[76px]' : 'pl-2',
      )}
      data-tauri-drag-region
    >
      <SectionNav />
      <div
        className={cn('flex h-full min-w-0 items-center gap-2', isMacOS && 'pr-2')}
        data-slot="titlebar-actions"
      >
        <FocusControls />
        {activeSection !== 'sftp' && !focusEnabled && (
          <Button
            variant={aiOpen ? 'secondary' : 'ghost'}
            size="icon"
            className="size-7"
            onClick={() => toggleAi(panelSection)}
            aria-pressed={aiOpen}
            aria-label={aiLabel}
            data-ai-mode={panelSection === 'terminal' ? 'agent' : 'ask'}
          >
            <AiToggleIcon />
          </Button>
        )}
        {!isMacOS && <WindowControls />}
      </div>
    </div>
  );
};
