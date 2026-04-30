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
    <div aria-label={ariaLabel} className={cn('segment', className)} role="group">
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={cn('segment-item', option.value === value && 'segment-item-active')}
          disabled={option.disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
