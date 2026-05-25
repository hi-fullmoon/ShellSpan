import { ChakraProvider as BaseChakraProvider, createSystem, defaultConfig } from '@chakra-ui/react';
import type { ReactNode } from 'react';

const system = createSystem(defaultConfig, {
  preflight: false,
  theme: {
    semanticTokens: {
      colors: {
        border: {
          DEFAULT: { value: 'var(--app-border)' },
        },
        bg: {
          DEFAULT: { value: 'var(--app-bg)' },
          muted: { value: 'var(--app-surface-muted)' },
          subtle: { value: 'var(--app-panel-secondary)' },
          panel: { value: 'var(--app-panel-primary)' },
        },
        fg: {
          DEFAULT: { value: 'var(--app-text)' },
          muted: { value: 'var(--app-text-muted)' },
          subtle: { value: 'var(--app-text-soft)' },
        },
      },
    },
  },
});

interface ChakraProviderProps {
  children: ReactNode;
}

export function ChakraProvider({ children }: ChakraProviderProps) {
  return (
    <BaseChakraProvider value={system}>
      {children}
    </BaseChakraProvider>
  );
}
