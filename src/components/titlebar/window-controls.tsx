import React from 'react';
import { cn } from '@/lib/utils';
import { useWindowControls } from '@/hooks/useWindowControls';

const ControlButton: React.FC<{
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
  ariaLabel: string;
}> = ({ onClick, className, children, ariaLabel }) => {
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(
        'flex h-full w-10 items-center justify-center text-app-text-soft transition-colors hover:bg-app-surface-muted hover:text-app-text',
        className,
      )}
    >
      {children}
    </button>
  );
};

export const WindowControls: React.FC = () => {
  const { minimize, toggleMaximize, close, isMaximized } = useWindowControls();

  return (
    <div className="flex h-full items-center">
      <ControlButton onClick={minimize} ariaLabel="minimize">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </ControlButton>
      <ControlButton onClick={toggleMaximize} ariaLabel="maximize">
        {isMaximized ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
            <rect x="5" y="9" width="10" height="10" rx="1" />
            <path d="M9 5h10v10" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
            <rect x="4" y="4" width="16" height="16" rx="1" />
          </svg>
        )}
      </ControlButton>
      <ControlButton
        onClick={close}
        ariaLabel="close"
        className="hover:bg-app-error hover:text-white"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </ControlButton>
    </div>
  );
};
