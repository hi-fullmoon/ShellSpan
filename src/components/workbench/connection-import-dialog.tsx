import React from 'react';
import { AlertTriangleIcon, FileKeyIcon, ServerIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/hooks/useI18n';
import type { ConnectionImportPreview } from '@/lib/connection-import';

interface ConnectionImportDialogProps {
  open: boolean;
  candidates: ConnectionImportPreview[];
  importing: boolean;
  onClose: () => void;
  onImport: (ids: string[]) => Promise<void>;
}

export const ConnectionImportDialog: React.FC<ConnectionImportDialogProps> = ({
  open,
  candidates,
  importing,
  onClose,
  onImport,
}) => {
  const { t } = useI18n();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (open) {
      setSelected(new Set(candidates.filter((candidate) => !candidate.conflict).map((candidate) => candidate.id)));
    }
  }, [candidates, open]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !importing) onClose(); }}>
      <CompactDialogContent className="max-w-2xl" showCloseButton={!importing}>
        <CompactDialogHeader
          title={t('workbench.connections.importPreviewTitle')}
          description={t('workbench.connections.importPreviewDescription')}
        />
        <CompactDialogBody className="max-h-[60vh] overflow-y-auto p-2">
          {candidates.map((candidate) => {
            const checked = selected.has(candidate.id);
            return (
              <label
                key={candidate.id}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 hover:bg-muted/50"
              >
                <Checkbox
                  checked={checked}
                  disabled={importing}
                  onCheckedChange={(next) => setSelected((current) => {
                    const updated = new Set(current);
                    if (next) updated.add(candidate.id);
                    else updated.delete(candidate.id);
                    return updated;
                  })}
                  aria-label={candidate.name}
                />
                <ServerIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{candidate.name}</span>
                    <Badge variant="outline">{candidate.source}</Badge>
                    {candidate.conflict && (
                      <Badge variant="destructive">{t('workbench.connections.importConflict')}</Badge>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {candidate.username}@{candidate.host}:{candidate.port}
                  </span>
                  {candidate.identityFile && (
                    <span className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
                      <FileKeyIcon className="size-3" />
                      {candidate.identityFile}
                    </span>
                  )}
                  {candidate.warnings.map((warning) => (
                    <span key={warning} className="mt-1 flex items-center gap-1 text-xs text-app-warning">
                      <AlertTriangleIcon className="size-3" />
                      {t(`workbench.connections.importWarning.${warning}` as Parameters<typeof t>[0])}
                    </span>
                  ))}
                </span>
              </label>
            );
          })}
        </CompactDialogBody>
        <CompactDialogFooter>
          <Button variant="outline" size="sm" disabled={importing} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={importing || selected.size === 0}
            onClick={() => void onImport([...selected])}
          >
            {importing
              ? t('workbench.connections.importing')
              : t('workbench.connections.importSelected', { count: selected.size })}
          </Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
};
