import { useEffect, useMemo, useRef, useState } from 'react';
import { Select, createListCollection } from '@chakra-ui/react';

interface FormSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  className?: string;
  placeholder?: string;
  id?: string;
  'aria-label'?: string;
}

export function FormSelect({ value, onChange, options, className = 'themed-input', placeholder, id, 'aria-label': ariaLabel }: FormSelectProps) {
  const collection = useMemo(() => createListCollection({ items: options.map((o) => ({ label: o.label, value: o.value })) }), [options]);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const positionerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !triggerRef.current || !positionerRef.current) {
      return;
    }

    const trigger = triggerRef.current;
    const positioner = positionerRef.current;

    const updatePosition = () => {
      const rect = trigger.getBoundingClientRect();
      positioner.style.position = 'fixed';
      positioner.style.top = `${rect.bottom + 4}px`;
      positioner.style.left = `${rect.left}px`;
      positioner.style.width = `${rect.width}px`;
      positioner.style.minWidth = 'auto';
      positioner.style.transform = 'none';
      positioner.style.zIndex = '9999';
    };

    updatePosition();
    const rafId = requestAnimationFrame(updatePosition);

    return () => cancelAnimationFrame(rafId);
  }, [open]);

  return (
    <Select.Root
      collection={collection}
      positioning={{ sameWidth: true }}
      size="sm"
      value={[value]}
      onOpenChange={(details) => setOpen(details.open)}
      onValueChange={(details) => onChange(details.value[0])}
    >
      <Select.Control className={className} css={{ border: '1px solid var(--app-border)', borderRadius: '4px', background: 'var(--app-icon-bg)' }}>
        <Select.Trigger ref={triggerRef} aria-label={ariaLabel} id={id} css={{ border: 'none', background: 'transparent' }}>
          <Select.ValueText placeholder={placeholder} />
        </Select.Trigger>
        <Select.IndicatorGroup>
          <Select.Indicator />
        </Select.IndicatorGroup>
      </Select.Control>
      <Select.Positioner ref={positionerRef}>
        <Select.Content>
          {collection.items.map((item) => (
            <Select.Item key={item.value} item={item}>
              <Select.ItemText>{item.label}</Select.ItemText>
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Positioner>
      <Select.HiddenSelect />
    </Select.Root>
  );
}
