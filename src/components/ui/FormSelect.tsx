import { useMemo } from 'react';
import { Portal, Select, createListCollection } from '@chakra-ui/react';

interface FormSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  className?: string;
  placeholder?: string;
  'aria-label'?: string;
}

export function FormSelect({ value, onChange, options, className = 'themed-input', placeholder, 'aria-label': ariaLabel }: FormSelectProps) {
  const collection = useMemo(() => createListCollection({ items: options.map((o) => ({ label: o.label, value: o.value })) }), [options]);

  return (
    <Select.Root
      collection={collection}
      positioning={{ strategy: 'fixed', sameWidth: true, gutter: 4 }}
      size="sm"
      value={[value]}
      onValueChange={(details) => onChange(details.value[0])}
    >
      <Select.HiddenSelect />
      <Select.Control>
        <Select.Trigger aria-label={ariaLabel} className={className}>
          <Select.ValueText placeholder={placeholder} />
        </Select.Trigger>
        <Select.IndicatorGroup>
          <Select.Indicator />
        </Select.IndicatorGroup>
      </Select.Control>
      <Portal>
        <Select.Positioner>
          <Select.Content style={{ zIndex: 1700 }}>
            {collection.items.map((item) => (
              <Select.Item item={item} key={item.value}>
                {item.label}
                <Select.ItemIndicator />
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
}
