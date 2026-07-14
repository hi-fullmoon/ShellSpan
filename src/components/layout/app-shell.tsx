import React from 'react';
import { cn } from '@/lib/utils';
import { TitleBar } from '@/components/titlebar/title-bar';

export interface AppShellProps {
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <TitleBar />
      {children}
    </div>
  );
};

export interface SidebarProps {
  children: React.ReactNode;
  className?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({ children, className }) => {
  return (
    <div
      className={cn(
        'flex h-full w-56 shrink-0 flex-col border-r border-app-border bg-app-surface-muted',
        className,
      )}
    >
      {children}
    </div>
  );
};

export interface MainContentProps {
  children: React.ReactNode;
}

export const MainContent: React.FC<MainContentProps> = ({ children }) => {
  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-app-bg">
      {children}
    </div>
  );
};
