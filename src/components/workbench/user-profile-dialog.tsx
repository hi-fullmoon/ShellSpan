import React from 'react';
import { CameraIcon } from 'lucide-react';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { UserAvatar } from '@/components/workbench/user-avatar';
import { useI18n } from '@/hooks/useI18n';
import { invokePickProfileAvatar } from '@/lib/ipc/tauri';
import { PROFILE_NAME_MAX_LENGTH, useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';

interface UserProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const UserProfileDialog: React.FC<UserProfileDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const setProfileName = useAppStore((state) => state.setProfileName);
  const setProfileAvatar = useAppStore((state) => state.setProfileAvatar);
  const [name, setName] = React.useState('');
  const [avatar, setAvatar] = React.useState('');
  const [picking, setPicking] = React.useState(false);
  const nameInputId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const { profileName: storedName, profileAvatar: storedAvatar } = useAppStore.getState();
    setName(storedName);
    setAvatar(storedAvatar);
  }, [open]);

  const displayName = name.trim() || t('workbench.userMenu.name');

  const handlePickAvatar = async (): Promise<void> => {
    if (picking) return;
    setPicking(true);
    try {
      const next = await invokePickProfileAvatar();
      if (next) setAvatar(next);
    } catch {
      useToastStore.getState().addToast(t('settings.profile.pickFailed'), 'error');
    } finally {
      setPicking(false);
    }
  };

  const handleSave = (): void => {
    setProfileName(name);
    setProfileAvatar(avatar);
    useToastStore.getState().addToast(t('settings.profile.saved'), 'success');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <CompactDialogContent className="max-w-sm" showCloseButton={false}>
        <CompactDialogHeader
          title={t('workbench.userMenu.editProfile')}
          description={t('settings.profile.description')}
        />
        <CompactDialogBody className="items-center gap-4">
          <button
            type="button"
            disabled={picking}
            aria-label={t('settings.profile.changeAvatar')}
            title={t('settings.profile.changeAvatar')}
            onClick={() => void handlePickAvatar()}
            className="relative block cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          >
            <UserAvatar
              avatar={avatar}
              name={displayName}
              className="size-20 ring-1 ring-app-border transition-shadow hover:ring-primary/60"
              iconClassName="size-8"
            />
            <span className="absolute right-0 bottom-0 flex size-6 items-center justify-center rounded-full bg-background text-foreground shadow-sm ring-1 ring-app-border">
              {picking
                ? <Spinner />
                : <CameraIcon className="size-3.5" aria-hidden />}
            </span>
          </button>
          {avatar && (
            <button
              type="button"
              className="-mt-1 cursor-pointer text-xs text-muted-foreground/80 underline-offset-4 outline-none hover:text-destructive hover:underline focus-visible:text-destructive focus-visible:underline"
              onClick={() => setAvatar('')}
            >
              {t('settings.profile.removeAvatar')}
            </button>
          )}
          <div className="flex w-full flex-col gap-2">
            <Label htmlFor={nameInputId} className="text-xs text-muted-foreground">
              {t('settings.profile.name')}
            </Label>
            <Input
              id={nameInputId}
              value={name}
              maxLength={PROFILE_NAME_MAX_LENGTH}
              placeholder={t('settings.profile.namePlaceholder')}
              className="h-8"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSave();
              }}
              autoFocus
            />
            <p className="text-xs leading-5 text-muted-foreground">
              {t('settings.profile.nameHint')}
            </p>
          </div>
        </CompactDialogBody>
        <CompactDialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave}>
            {t('common.save')}
          </Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
};
