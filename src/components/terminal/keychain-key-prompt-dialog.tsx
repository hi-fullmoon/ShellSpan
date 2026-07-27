import React, { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { CompactDialogBody, CompactDialogContent, CompactDialogFooter, CompactDialogHeader } from '@/components/ui/compact-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useKeychainKeyPromptStore } from '@/stores/keychainKeyPromptStore';
import { useKeychainStore } from '@/stores/keychainStore';

export const KeychainKeyPromptDialog: React.FC = () => {
  const { t } = useI18n();
  const pending = useKeychainKeyPromptStore((state) => state.pending);
  const resolveKey = useKeychainKeyPromptStore((state) => state.resolveKey);
  const { keys: allKeys, initialized, hydrate } = useKeychainStore();
  const keys = allKeys.filter((k) => k.kind === 'keyFile');
  const [selectedKeyId, setSelectedKeyId] = useState('');

  useEffect(() => {
    if (pending) {
      setSelectedKeyId('');
      if (!initialized) {
        void hydrate();
      }
    }
  }, [pending, initialized, hydrate]);

  const handleCancel = (): void => {
    resolveKey(null);
  };

  const handleConfirm = (): void => {
    if (!selectedKeyId) return;
    resolveKey({ kind: 'key', keyId: selectedKeyId });
  };

  return (
    <Dialog
      open={!!pending}
      onOpenChange={(next) => {
        if (!next) handleCancel();
      }}
    >
      <CompactDialogContent className="max-w-sm" showCloseButton={false}>
        <CompactDialogHeader
          title={t('dialog.keychainKeyPrompt.title')}
          description={
            pending
              ? t('dialog.keychainKeyPrompt.description', {
                  username: pending.request.username,
                  host: pending.request.host,
                })
              : undefined
          }
        />
        <CompactDialogBody>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="keychain-key-select" className="text-xs text-muted-foreground">
                {t('common.keychainKey')}
              </Label>
              {keys.length === 0 ? (
                <div className="rounded-lg border border-dashed border-app-border px-3 py-2 text-sm text-muted-foreground">
                  {t('connection.form.noKeychainKeys')}
                </div>
              ) : (
                <Select value={selectedKeyId} onValueChange={(next) => setSelectedKeyId(next ?? '')}>
                  <SelectTrigger id="keychain-key-select">
                    <SelectValue placeholder={t('connection.form.selectKeychainKey')}>
                      {keys.find((key) => key.id === selectedKeyId)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {keys.map((key) => (
                      <SelectItem key={key.id} value={key.id}>
                        <span className="flex items-center gap-2">
                          <span>{key.label}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        </CompactDialogBody>
        <CompactDialogFooter>
          <Button variant="outline" size="sm" onClick={handleCancel}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={!selectedKeyId}>
            {t('common.confirm')}
          </Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
};
