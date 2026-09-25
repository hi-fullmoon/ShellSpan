import React from 'react';
import { DrawerContent, DrawerHeader } from '@/components/ui/drawer';
import { cn } from '@/lib/utils';

export const DeploymentDrawerContext = React.createContext(false);

export const DeploymentDrawerContent: React.FC<React.ComponentProps<typeof DrawerContent>> = ({ children, className, ...props }) => (
  <DrawerContent
    {...props}
    className={cn('min-h-0 gap-0 overflow-hidden p-0', className)}
    closeButtonClassName="top-2 right-3 size-8 [&_svg]:size-3.5"
  >
    <DeploymentDrawerContext.Provider value>
      {children}
    </DeploymentDrawerContext.Provider>
  </DrawerContent>
);

export const DeploymentDrawerHeader: React.FC<React.ComponentProps<typeof DrawerHeader>> = ({ className, ...props }) => (
  <DrawerHeader
    {...props}
    className={cn('min-h-12 shrink-0 justify-center gap-1 border-b px-3 py-3 pr-12 [&_[data-slot=drawer-title]]:leading-6', className)}
  />
);
