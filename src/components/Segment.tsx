import { SegmentGroup } from '@chakra-ui/react';
import { cn } from '../lib/ui';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SegmentProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}

export function Segment<T extends string>({ options, value, onChange, ariaLabel, className }: SegmentProps<T>) {
  return (
    <SegmentGroup.Root
      aria-label={ariaLabel}
      className={cn('flex rounded p-0.5 gap-0.5', className)}
      value={value}
      onValueChange={(details) => onChange(details.value as T)}
      css={{
        background: 'var(--app-icon-bg)',
        border: '1px solid var(--app-border)',
        borderRadius: '4px',
      }}
    >
      {options.map((option) => (
        <SegmentGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className="flex-1 cursor-pointer rounded px-2 py-0.5 text-center text-xs font-medium transition-colors"
          css={{
            color: 'var(--app-text-soft)',
            '&[data-state="checked"], &[data-checked]': {
              background: 'color-mix(in srgb, var(--app-surface) 82%, var(--app-primary-bg) 12%)',
              color: 'var(--app-text)',
            },
            '&:hover:not([data-state="checked"]):not([data-checked])': {
              color: 'var(--app-text)',
            },
            '&:disabled': {
              opacity: 0.5,
              cursor: 'not-allowed',
            },
          }}
        >
          <SegmentGroup.ItemHiddenInput />
          <SegmentGroup.ItemText>{option.label}</SegmentGroup.ItemText>
        </SegmentGroup.Item>
      ))}
    </SegmentGroup.Root>
  );
}
