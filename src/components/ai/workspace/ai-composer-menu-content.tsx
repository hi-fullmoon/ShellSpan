import { BookOpenIcon, FilePlusIcon, FolderPlusIcon } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { builtinSkills } from '@/lib/ai/builtin-skills';
import type { MentionGroup, MentionOption } from './ai-mention-panel';

/** Shared entries for the + menu and the initial @ menu. */
export function useComposerMenuGroups({ agent, onAddFile, onAddFolder, onSkill }: {
  agent: boolean;
  onAddFile: () => void;
  onAddFolder: () => void;
  onSkill: (name: string) => void;
}): MentionGroup[] {
  const { t, locale } = useI18n();
  return [
    { label: t('ai.workspace.addMenu.add'), options: [
      { key: 'upload', label: t('ai.workspace.attachments.file'), detail: t('ai.workspace.addMenu.fileHint'), inlineDetail: true, icon: <FilePlusIcon />, choose: onAddFile },
      ...(agent ? [{ key: 'project', label: t('ai.workspace.attachments.folder'), detail: t('ai.workspace.addMenu.folderHint'), inlineDetail: true, icon: <FolderPlusIcon />, choose: onAddFolder }] : []),
    ] },
    ...(agent ? [{ label: t('ai.workspace.skills.title'), options: builtinSkills.map(skill => ({
      key: `skill:${skill.name}`, label: locale === 'zh-CN' ? skill.descriptionZh : skill.description,
      detail: `/${skill.name}`, searchText: `${skill.description} ${skill.descriptionZh}`, icon: <BookOpenIcon />, choose: () => onSkill(skill.name),
    })) }] : []),
    { label: t('ai.workspace.addMenu.history'), options: [], showEmptyLabel: true,
      notice: t(agent ? 'ai.workspace.addMenu.mentionSearchHint' : 'ai.workspace.addMenu.searchHistoryHint'),
    },
  ];
}

export function AiComposerMenuRow({ option }: { option: MentionOption }) {
  const { t } = useI18n();
  const menuEntry = option.inlineDetail || option.key.startsWith('skill:');
  return <>
    {option.icon}
    <span className={option.inlineDetail ? 'inline-grid shrink-0 text-left' : 'min-w-0 flex-1 truncate text-left'}>
      {option.inlineDetail ? <>
        {/* Both rows reserve the same intrinsic width in every locale. */}
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">{t('ai.workspace.attachments.file')}</span>
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">{t('ai.workspace.attachments.folder')}</span>
        <span className="col-start-1 row-start-1">{option.label}</span>
      </> : option.label}
    </span>
    {option.detail && <span className={option.inlineDetail ? 'truncate text-xs text-muted-foreground' : menuEntry ? 'shrink-0 text-xs text-muted-foreground' : 'ml-auto max-w-[45%] shrink-0 truncate text-xs font-normal text-muted-foreground'}>{option.detail}</span>}
  </>;
}
