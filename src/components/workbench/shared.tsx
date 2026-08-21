import React from 'react';
import { cn } from '@/lib/utils';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';

/** Shared key-type badge styling for management cards (keychain, known hosts). */
export const KEY_TYPE_BADGE_STYLES: Record<string, string> = {
  ECDSA: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  RSA: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  ED25519: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  DSA: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
};

export const keyTypeBadgeClass = (keyType: string): string =>
  KEY_TYPE_BADGE_STYLES[keyType.toUpperCase()] ?? 'bg-app-surface-muted text-muted-foreground';

/** Minimum width that keeps management-card content and actions comfortable. */
export const MANAGEMENT_CARD_MIN_WIDTH = '22rem';

interface FormRowProps {
  label: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
  controlId?: string;
}

export const FormRow: React.FC<FormRowProps> = ({ label, error, children, className, controlId }) => {
  return (
    <Field data-invalid={Boolean(error)} className={className}>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      {children}
      <FieldError id={controlId && error ? `${controlId}-error` : undefined}>{error}</FieldError>
    </Field>
  );
};
