import { useRef, useState } from 'react';
import { AppWindowIcon, ChevronDownIcon, ExternalLinkIcon, FolderOpenIcon, SaveIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/empty-state';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { usePlatform } from '@/hooks/usePlatform';
import type { SftpPreviewFileActions, SftpPreviewTarget } from '@/hooks/useSftpPaneActions';
import type { FileOpenApplication } from '@/types';

function ApplicationIcon({ icon, inButton = false }: { icon?: string; inButton?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!icon || failed) return inButton ? null : <AppWindowIcon aria-hidden="true" />;
  return (
    <img
      src={icon}
      alt=""
      data-icon={inButton ? 'inline-start' : undefined}
      className="size-4 shrink-0 object-contain data-[icon=inline-start]:size-3.5"
      onError={() => setFailed(true)}
    />
  );
}

export function SftpPreviewOpenControls({ target, actions, defaultIcon }: {
  target: SftpPreviewTarget;
  actions: SftpPreviewFileActions;
  defaultIcon?: string;
}) {
  const { t } = useI18n();
  const hasSystemPicker = usePlatform() === 'windows';
  const [applications, setApplications] = useState<FileOpenApplication[] | null>();
  const queryId = useRef(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await operation();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const onMenuChange = (open: boolean) => {
    const id = ++queryId.current;
    if (!open || hasSystemPicker) return;
    setApplications(undefined);
    void actions.listApplications(target).then(
      (result) => { if (queryId.current === id) setApplications(result); },
      () => { if (queryId.current === id) setApplications(null); },
    );
  };

  return (
    <div data-slot="sftp-preview-file-actions" className="flex shrink-0 items-center" aria-busy={busy}>
      <Tooltip>
        <TooltipTrigger render={
          <Button
            variant="ghost"
            size="sm"
            className="rounded-r-none focus-visible:relative focus-visible:z-10"
            disabled={busy}
            onClick={() => void run(() => actions.open(target))}
          />
        }>
          {busy ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <ApplicationIcon key={defaultIcon} icon={defaultIcon} inButton />}
          {t('sftp.preview.open')}
        </TooltipTrigger>
        <TooltipContent>{t(actions.isRemote ? 'sftp.preview.openLocalCopy' : 'sftp.preview.openExternally')}</TooltipContent>
      </Tooltip>
      <DropdownMenu modal={false} onOpenChange={onMenuChange}>
        <DropdownMenuTrigger
          disabled={busy}
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative rounded-l-none focus-visible:z-10"
              aria-label={t('sftp.preview.openOptions')}
            />
          }
        >
          <Separator
            render={<span />}
            orientation="vertical"
            className="pointer-events-none absolute inset-y-2.5 left-0 data-vertical:border-border/65"
            aria-hidden="true"
          />
          <ChevronDownIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="file-action-menu flex w-max min-w-56 max-w-72 flex-col overflow-hidden">
          <DropdownMenuGroup
            data-slot="sftp-preview-open-applications"
            className="min-h-0 max-h-[280px] overflow-x-hidden overflow-y-auto overscroll-contain"
          >
            <DropdownMenuItem onClick={() => void run(() => actions.open(target))}>
              <ExternalLinkIcon />
              {t(actions.isRemote ? 'sftp.preview.defaultApplicationCopy' : 'sftp.preview.defaultApplication')}
            </DropdownMenuItem>
            {hasSystemPicker && (
              <DropdownMenuItem inset onClick={() => void run(() => actions.open(target, 'system-picker'))}>
                {t('sftp.preview.chooseApplication')}
              </DropdownMenuItem>
            )}
            {applications?.map((application) => (
              <DropdownMenuItem key={application.id} onClick={() => void run(() => actions.open(target, application.id))}>
                <ApplicationIcon key={application.icon} icon={application.icon} />
                {application.name}
              </DropdownMenuItem>
            ))}
            {!hasSystemPicker && !applications?.length && (
              <DropdownMenuItem inset disabled>
                {t(applications === undefined ? 'common.loading' : applications === null
                  ? 'sftp.preview.applicationsFailed' : 'sftp.preview.noApplications')}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator className="shrink-0" />
          <DropdownMenuGroup className="shrink-0">
            <DropdownMenuItem onClick={() => void run(() => actions.reveal(target))}>
              <FolderOpenIcon />
              {t(actions.isRemote ? 'sftp.preview.revealRemote' : 'sftp.preview.revealLocal')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void run(() => actions.saveAs(target))}>
              <SaveIcon />
              {t('sftp.preview.saveAs')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
