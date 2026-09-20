import { Fragment } from 'react';
import { FileIcon, FileTextIcon, FileCodeIcon, FileSpreadsheetIcon, XIcon } from 'lucide-react';
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from '@/components/ui/attachment';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import type { DocumentAttachment } from '@/lib/ai/document-message';
import { documentExtension } from '@/lib/ai/document-import';
import { formatBytes } from '@/lib/utils';

export function AiDocumentAttachments({ documents, pending = [], onRemove, locked = false, composer = false }: {
  composer?: boolean;
  documents: readonly DocumentAttachment[];
  pending?: readonly Pick<File, 'name' | 'size'>[];
  onRemove?: (id: string) => void;
  locked?: boolean;
}) {
  const { t } = useI18n();
  if (!documents.length && !pending.length) return null;
  const description = (file: Pick<File, 'name' | 'size'>) => `${documentExtension(file.name).toUpperCase()} · ${formatBytes(file.size)}`;
  const Group = composer ? Fragment : AttachmentGroup;
  const fileIcon = (name: string) => /\.(xlsx?|csv|ods)$/iu.test(name) ? <FileSpreadsheetIcon /> : /\.(json|md|html|xml|ya?ml|tsx?|jsx?|py|rs|sh)$/iu.test(name) ? <FileCodeIcon /> : <FileTextIcon />;
  return <Group {...(composer ? {} : { className: 'max-w-full', 'aria-label': t('ai.workspace.documents.attached') })}>
    {documents.map(document => <Dialog key={document.id}>
      <Attachment size="sm" orientation={composer ? 'vertical' : 'horizontal'} className={composer ? 'ai-composer-file-card' : 'max-w-64'} data-document-name={document.name}>
        <AttachmentMedia>{composer ? <FileIcon /> : <FileTextIcon />}</AttachmentMedia>
        <AttachmentContent>
          {composer && fileIcon(document.name)}<AttachmentTitle title={document.name}>{document.name}</AttachmentTitle>
          <AttachmentDescription className={composer ? 'sr-only' : undefined}>{description(document)} · {t('ai.workspace.documents.ready')}</AttachmentDescription>
        </AttachmentContent>
        <DialogTrigger render={<AttachmentTrigger aria-label={t('ai.workspace.documents.preview', { name: document.name })} />} />
        {onRemove && <AttachmentActions><AttachmentAction disabled={locked} aria-label={t('ai.workspace.documents.remove', { name: document.name })} onClick={() => onRemove(document.id)}><XIcon /></AttachmentAction></AttachmentActions>}
      </Attachment>
      <DialogContent className="flex h-[min(640px,85dvh)] min-h-0 flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-4 pt-4 pr-10">
          <DialogTitle className="break-all">{document.name}</DialogTitle>
          <DialogDescription>{t('ai.workspace.documents.previewHint')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <pre className="whitespace-pre-wrap break-words px-4 pb-4 text-sm">{document.text}</pre>
        </ScrollArea>
      </DialogContent>
    </Dialog>)}
    {pending.map((file, index) => <Attachment key={`${index}:${file.name}`} state="processing" aria-busy="true" size="sm" orientation={composer ? 'vertical' : 'horizontal'} className={composer ? 'ai-composer-file-card' : 'max-w-64'}>
      <AttachmentMedia><Spinner /></AttachmentMedia>
      <AttachmentContent><AttachmentTitle>{file.name}</AttachmentTitle><AttachmentDescription>{description(file)} · {t('ai.workspace.documents.processing')}</AttachmentDescription></AttachmentContent>
    </Attachment>)}
  </Group>;
}
