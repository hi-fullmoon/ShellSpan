import { Tooltip as ChakraTooltip } from '@chakra-ui/react';
import type { ReactNode } from 'react';

interface TooltipProviderProps {
  children: ReactNode;
}

export function TooltipProvider({ children }: TooltipProviderProps) {
  return <>{children}</>;
}

interface TooltipProps {
  content: string;
  children: ReactNode;
}

export function Tooltip({ content, children }: TooltipProps) {
  return (
    <ChakraTooltip.Root openDelay={2000} closeDelay={200}>
      <ChakraTooltip.Trigger asChild>{children}</ChakraTooltip.Trigger>
      <ChakraTooltip.Content>{content}</ChakraTooltip.Content>
    </ChakraTooltip.Root>
  );
}
