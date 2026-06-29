import { useMemo } from 'react';
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

  return (
    <Select.Root
      collection={collection}
      positioning={{ sameWidth: true, gutter: 4 }}
      size="sm"
      value={[value]}
      onValueChange={(details) => onChange(details.value[0])}
    >
      <Select.Control>
        <Select.Trigger aria-label={ariaLabel} id={id} className={className}>
          <Select.ValueText placeholder={placeholder} />
        </Select.Trigger>
        <Select.IndicatorGroup>
          <Select.Indicator />
        </Select.IndicatorGroup>
      </Select.Control>
      <Select.Positioner>
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
