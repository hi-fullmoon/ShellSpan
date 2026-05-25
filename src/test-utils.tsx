import { render as tlRender, type RenderOptions } from '@testing-library/react';
import { ChakraProvider } from './components/ChakraProvider';
import type { ReactElement, ReactNode } from 'react';

function Wrapper({ children }: { children: ReactNode }) {
  return <ChakraProvider>{children}</ChakraProvider>;
}

export function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return tlRender(ui, { wrapper: Wrapper, ...options });
}

export * from '@testing-library/react';
