import React from 'react';
import { PlusIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import type {
  DeploymentNodeCategory,
  DeploymentNodeTypeCatalog,
  DeploymentNodeTypeSpec,
} from '@/lib/deployment/types';
import { WorkbenchSearchInput } from '../workbench-page';
import { deploymentLocaleKey } from './deployment-editor-ui';

interface NodeLibraryPaneProps {
  catalog: DeploymentNodeTypeCatalog;
  onAdd: (spec: DeploymentNodeTypeSpec) => void;
}

const NodeLibraryPane: React.FC<NodeLibraryPaneProps> = ({ catalog, onAdd }) => {
  const { t } = useI18n();
  const [search, setSearch] = React.useState('');
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const grouped = React.useMemo(() => {
    const groups = new Map<DeploymentNodeCategory, DeploymentNodeTypeSpec[]>();
    for (const spec of catalog.nodes) {
      const name = t(deploymentLocaleKey(spec.displayNameKey));
      const description = t(deploymentLocaleKey(spec.descriptionKey));
      if (normalizedSearch && !`${name} ${description}`.toLocaleLowerCase().includes(normalizedSearch)) {
        continue;
      }
      const entries = groups.get(spec.category) ?? [];
      entries.push(spec);
      groups.set(spec.category, entries);
    }
    return [...groups.entries()];
  }, [catalog.nodes, normalizedSearch, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="deployment-node-library">
      <div className="shrink-0 px-4 pb-3">
        <WorkbenchSearchInput
          containerClassName="min-w-0 w-full flex-1"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('deployment.editor.searchNodes')}
          aria-label={t('deployment.editor.searchNodes')}
          onClear={() => setSearch('')}
          clearLabel={t('common.clear')}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col px-4 pb-4">
          {grouped.map(([category, specs], groupIndex) => (
            <section key={category} className="flex flex-col gap-1.5 py-2">
              {groupIndex > 0 && <Separator className="mb-2" />}
              <div className="flex items-center justify-between gap-2 px-1">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t(deploymentLocaleKey(`deployment.editor.category.${category}`))}
                </h3>
                <Badge variant="outline" size="sm">{specs.length}</Badge>
              </div>
              {specs.map((spec) => {
                const name = t(deploymentLocaleKey(spec.displayNameKey));
                return (
                  <Button
                    key={`${spec.typeName}@${spec.typeVersion}`}
                    variant="ghost"
                    className="h-auto min-w-0 items-start justify-start px-1 py-2 text-left"
                    onClick={() => onAdd(spec)}
                    aria-label={t('deployment.editor.addNodeNamed', { name })}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{name}</p>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {t(deploymentLocaleKey(spec.descriptionKey))}
                      </p>
                    </div>
                    <PlusIcon data-icon="inline-end" aria-hidden />
                  </Button>
                );
              })}
            </section>
          ))}
          {grouped.length === 0 && (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              {t('deployment.editor.noNodeSearchResults')}
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

export interface NodeLibraryDrawerProps extends NodeLibraryPaneProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocusRef?: React.RefObject<HTMLButtonElement | null>;
}

export const NodeLibraryDrawer: React.FC<NodeLibraryDrawerProps> = ({
  open,
  onOpenChange,
  catalog,
  onAdd,
  finalFocusRef,
}) => {
  const { t } = useI18n();
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="min-h-0 gap-0 overflow-hidden p-0" finalFocus={finalFocusRef}>
        <DrawerHeader className="shrink-0 border-b p-4">
          <DrawerTitle>{t('deployment.editor.nodeLibrary')}</DrawerTitle>
          <p className="text-xs text-muted-foreground">
            {t('deployment.editor.nodeLibraryDescription')}
          </p>
        </DrawerHeader>
        <NodeLibraryPane catalog={catalog} onAdd={onAdd} />
      </DrawerContent>
    </Drawer>
  );
};
