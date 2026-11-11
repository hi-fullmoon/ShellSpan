import React from 'react';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';

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
