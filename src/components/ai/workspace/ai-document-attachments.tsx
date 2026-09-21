import { Fragment } from 'react';
import { FileTextIcon, FileCodeIcon, FileCogIcon, FileSpreadsheetIcon, MessageCircleIcon, XIcon } from 'lucide-react';
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from '@/components/ui/attachment';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import type { DocumentAttachment } from '@/lib/ai/document-message';
import { documentExtension } from '@/lib/ai/document-import';
import { formatBytes } from '@/lib/utils';

type DocumentKind = 'pdf' | 'word' | 'excel' | 'spreadsheet' | 'markdown' | 'json' | 'config' | 'code' | 'text';

function documentKind(name: string): DocumentKind {
  const extension = documentExtension(name);
  if (extension === 'pdf') return 'pdf';
  if (extension === 'docx') return 'word';
  if (extension === 'xlsx') return 'excel';
  if (extension === 'csv' || extension === 'tsv') return 'spreadsheet';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'json' || extension === 'jsonl') return 'json';
  if (['yaml', 'yml', 'toml', 'ini', 'conf'].includes(extension)) return 'config';
  if (/^(?:css|scss|js|jsx|ts|tsx|py|rs|go|java|c|h|cpp|hpp|sh|bash|zsh|sql|vue|svelte|xml|html|htm)$/u.test(extension)) return 'code';
  return 'text';
}

function LabeledDocumentIcon({ kind, label }: { kind: DocumentKind; label: 'PDF' | 'W' | 'X' | 'MD' | '{}' }) {
  return <svg data-slot="document-kind-icon" data-file-type-icon={kind} className="size-4 group-data-[orientation=vertical]/attachment:size-6" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <path d="M5 2.5h9l5 5v14H5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M14 2.5v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <rect x="1" y="11" width="22" height="9" rx="1.5" fill="currentColor" />
    <text x="12" y="17.8" textAnchor="middle" fill="var(--card)" fontSize={label === 'PDF' ? 8 : label.length === 2 ? 9 : 10} fontWeight="700" fontFamily="Arial, sans-serif">{label}</text>
  </svg>;
}

function DocumentKindIcon({ kind }: { kind: DocumentKind }) {
  if (kind === 'pdf') return <LabeledDocumentIcon kind="pdf" label="PDF" />;
  if (kind === 'word') return <LabeledDocumentIcon kind="word" label="W" />;
  if (kind === 'excel') return <LabeledDocumentIcon kind="excel" label="X" />;
  if (kind === 'markdown') return <LabeledDocumentIcon kind="markdown" label="MD" />;
  if (kind === 'json') return <LabeledDocumentIcon kind="json" label="{}" />;
  const Icon = kind === 'spreadsheet' ? FileSpreadsheetIcon : kind === 'config' ? FileCogIcon : kind === 'code' ? FileCodeIcon : FileTextIcon;
  return <Icon data-slot="document-kind-icon" aria-hidden="true" />;
}

export function AiDocumentAttachments({ documents, pending = [], onRemove, onCancel, locked = false, composer = false }: {
  composer?: boolean;
  documents: readonly DocumentAttachment[];
  pending?: readonly Pick<File, 'name' | 'size'>[];
  onRemove?: (id: string) => void;
  onCancel?: () => void;
  locked?: boolean;
}) {
  const { t } = useI18n();
  if (!documents.length && !pending.length) return null;
  const description = (file: Pick<File, 'name' | 'size'>) => `${documentExtension(file.name).toUpperCase()} · ${formatBytes(file.size)}`;
  const Group = composer ? Fragment : AttachmentGroup;
  return <Group {...(composer ? {} : { className: 'max-w-full', 'aria-label': t('ai.workspace.documents.attached') })}>
    {documents.map(document => {
      const chat = document.chatTitle !== undefined;
      const title = document.chatTitle ?? document.name;
      return <Dialog key={document.id}>
      <Attachment size="sm" orientation={composer && !chat ? 'vertical' : 'horizontal'} className={chat ? 'ai-chat-reference' : composer ? 'ai-composer-file-card focus-within:ring-0' : 'max-w-64'} data-document-name={document.name} data-file-kind={chat ? 'chat' : documentKind(document.name)}>
        <AttachmentMedia>{chat ? <MessageCircleIcon aria-hidden="true" /> : <DocumentKindIcon kind={documentKind(document.name)} />}</AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{title}</AttachmentTitle>
          <AttachmentDescription className={composer || chat ? 'sr-only' : undefined}>{description(document)} · {t('ai.workspace.documents.ready')}</AttachmentDescription>
        </AttachmentContent>
        <DialogTrigger render={<AttachmentTrigger aria-label={t('ai.workspace.documents.preview', { name: title })} />} />
        {onRemove && <AttachmentActions className={composer && !chat ? 'absolute' : undefined}><AttachmentAction variant={composer && !chat ? 'secondary' : undefined} className={composer ? 'ai-composer-file-remove size-5' : undefined} disabled={locked} aria-label={t('ai.workspace.documents.remove', { name: title })} onClick={() => onRemove(document.id)}><XIcon /></AttachmentAction></AttachmentActions>}
      </Attachment>
      <DialogContent className="flex h-[90dvh] w-[calc(100vw-2rem)] max-w-[960px] min-h-0 flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-4 pt-4 pr-10">
          <DialogTitle className="break-all">{title}</DialogTitle>
          <DialogDescription>{t('ai.workspace.documents.previewHint')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <pre className="whitespace-pre-wrap break-words px-4 pb-4 text-sm">{document.text}</pre>
        </ScrollArea>
      </DialogContent>
    </Dialog>;
    })}
    {pending.map((file, index) => <Attachment key={`${index}:${file.name}`} state="processing" aria-busy="true" size="sm" orientation={composer ? 'vertical' : 'horizontal'} className={composer ? 'ai-composer-file-card focus-within:ring-0' : 'max-w-64'} data-file-kind={documentKind(file.name)}>
      <AttachmentMedia>{composer ? <><DocumentKindIcon kind={documentKind(file.name)} /><span className="ai-composer-file-loading"><Spinner className="size-3" /></span></> : <Spinner />}</AttachmentMedia>
      <AttachmentContent><AttachmentTitle>{file.name}</AttachmentTitle><AttachmentDescription className={composer ? 'sr-only' : undefined}>{description(file)} · {t('ai.workspace.documents.processing')}</AttachmentDescription></AttachmentContent>
      {onCancel && <AttachmentActions className={composer ? 'absolute' : undefined}><AttachmentAction variant={composer ? 'secondary' : 'outline'} size={composer ? 'icon-xs' : 'xs'} className={composer ? 'ai-composer-file-remove size-5' : 'h-5 px-1'} aria-label={composer ? t('common.cancel') : undefined} onClick={onCancel}>{composer ? <XIcon /> : t('common.cancel')}</AttachmentAction></AttachmentActions>}
    </Attachment>)}
  </Group>;
}
