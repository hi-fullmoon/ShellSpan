import React from 'react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import type { ResponsiveGridBreakpoint } from '@/components/ui/responsive-card-grid';

/** Shared key-type badge styling for management cards (keychain, known hosts). */
export const KEY_TYPE_BADGE_STYLES: Record<string, string> = {
  ECDSA: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  RSA: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  ED25519: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  DSA: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
};

export const keyTypeBadgeClass = (keyType: string): string =>
  KEY_TYPE_BADGE_STYLES[keyType.toUpperCase()] ?? 'bg-app-surface-muted text-muted-foreground';

/** Shared column breakpoints for the management-card grids. */
export const CARD_GRID_BREAKPOINTS: readonly ResponsiveGridBreakpoint[] = [
  { minWidth: 800, columns: 2 },
  { minWidth: 900, columns: 3 },
];

interface FormRowProps {
  label: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}

export const FormRow: React.FC<FormRowProps> = ({ label, error, children, className }) => {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {error && <span className="text-xs text-app-error">{error}</span>}
    </div>
  );
};
