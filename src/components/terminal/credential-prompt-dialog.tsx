import React, { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (pending) {
      setPassword('');
      setRemember(false);
    }
  }, [pending]);

  const handleCancel = (): void => {
    resolvePassword(null);
  };

  const handleConfirm = (): void => {
    if (!password) return;
    resolvePassword({ password, remember });
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
            pending
              ? t('dialog.credentialPrompt.description', {
                  username: pending.request.username,
                  host: pending.request.host,
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirm();
                }}
                autoFocus
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-app-text-soft cursor-pointer select-none">
              <Checkbox id="remember-password" checked={remember} onCheckedChange={(checked) => setRemember(Boolean(checked))} className="p-0" />
              <span className="leading-5">{t('dialog.credentialPrompt.rememberPassword')}</span>
            </label>
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
