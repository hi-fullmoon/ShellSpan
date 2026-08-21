import React from 'react';
import { cn } from '@/lib/utils';
import { usePlatform } from '@/hooks/usePlatform';
import { SectionNav } from './section-nav';
import { WindowControls } from './window-controls';
import { SparklesIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAiStore } from '@/stores/aiStore';
import { useI18n } from '@/hooks/useI18n';

export const TitleBar: React.FC = () => {
  const platform = usePlatform();
  const isMacOS = platform === 'macos';
  const { t } = useI18n();
  const aiOpen = useAiStore((state) => state.open);
  const toggleAi = useAiStore((state) => state.toggleOpen);

  return (
    <div
      className={cn(
        'flex h-10 w-full shrink-0 items-center justify-between border-b border-app-border/50 bg-app-surface/90 backdrop-blur-sm',
        isMacOS ? 'pl-[76px]' : 'pl-2',
      )}
      data-tauri-drag-region
    >
      <SectionNav />
      <div className="flex h-full items-center" data-tauri-drag-region="false">
        <Button
          variant={aiOpen ? 'secondary' : 'ghost'}
          size="icon"
          className="size-7"
          onClick={toggleAi}
          aria-pressed={aiOpen}
          aria-label={t('ai.toggle')}
        >
          <SparklesIcon />
        </Button>
        {!isMacOS && <WindowControls />}
      </div>
    </div>
  );
};
