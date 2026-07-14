import React from 'react';
import { cn } from '@/lib/utils';
import { usePlatform } from '@/hooks/usePlatform';
import { SectionNav } from './section-nav';
import { WindowControls } from './window-controls';

export const TitleBar: React.FC = () => {
  const platform = usePlatform();
  const isMacOS = platform === 'macos';

  return (
    <div
      className={cn(
        'flex h-10 w-full shrink-0 items-center justify-between border-b border-app-border bg-app-surface/90 backdrop-blur-sm',
        isMacOS && 'pl-[76px]',
      )}
      data-tauri-drag-region
    >
      <SectionNav />
      {!isMacOS && <WindowControls />}
    </div>
  );
};
