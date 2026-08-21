import React, { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useLastValue } from '@/hooks/useLastValue';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CompactDialogBody, CompactDialogContent, CompactDialogFooter, CompactDialogHeader } from '@/components/ui/compact-dialog';
import { usePasswordPromptStore } from '@/stores/passwordPromptStore';

export const CredentialPromptDialog: React.FC = () => {
  const { t } = useI18n();
  const pending = usePasswordPromptStore((state) => state.pending);
  const resolvePassword = usePasswordPromptStore((state) => state.resolvePassword);
  const [password, setPassword] = useState('');
  const displayPending = useLastValue(pending);

  useEffect(() => {
    if (pending) {
      setPassword('');
    }
  }, [pending]);

  const handleCancel = (): void => {
    resolvePassword(null);
  };

  const handleConfirm = (): void => {
    if (!password) return;
    resolvePassword({ password });
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
          title={t('dialog.credentialPrompt.title')}
          description={
            displayPending
              ? t('dialog.credentialPrompt.description', {
                  username: displayPending.request.username,
                  host: displayPending.request.host,
                })
              : undefined
          }
        />
        <CompactDialogBody>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="credential-password" className="text-xs text-muted-foreground">
                {t('common.password')}
              </Label>
              <Input
                id="credential-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirm();
                }}
                autoFocus
              />
            </div>
          </div>
        </CompactDialogBody>
        <CompactDialogFooter>
          <Button variant="outline" size="sm" onClick={handleCancel}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={!password}>
            {t('common.connect')}
          </Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
};
