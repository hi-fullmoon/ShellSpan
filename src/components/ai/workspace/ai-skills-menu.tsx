import { useEffect, useRef, useState } from 'react';
import { BookOpenIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { InputGroupButton } from '@/components/ui/input-group';
import { AiProjectDirectoryInput } from './ai-project-directory-input';
import { useI18n } from '@/hooks/useI18n';
import type { SkillUserList } from '@/types/agent-skill';

export function AiSkillsMenu({ query, onSelect, disabled, needsRoot, targetLabel }: { query: (root?: string) => Promise<SkillUserList>; onSelect: (name: string) => void; disabled?: boolean; needsRoot?: boolean; targetLabel?: string }): React.ReactNode {
  const { t } = useI18n();
  const [result, setResult] = useState<SkillUserList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [root, setRoot] = useState('');
  const [open, setOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const refresh = async (): Promise<void> => {
    const current = ++generation.current;
    setLoading(true); setError(null); setResult(null);
    try { const next = await query(needsRoot ? root : undefined); if (current === generation.current) { setResult(next); if (projectOpen) { setProjectOpen(false); setOpen(true); } } }
    catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : t('ai.workspace.skills.unavailable')); }
    finally { if (current === generation.current) setLoading(false); }
  };
  return <><DropdownMenu open={open} onOpenChange={(next) => { if (next && needsRoot) { setProjectOpen(true); return; } setOpen(next); if (next) void refresh(); }}>
    {needsRoot ? <InputGroupButton disabled={disabled} aria-label={t('ai.workspace.skills.title')} onClick={() => setProjectOpen(true)}><BookOpenIcon data-icon="inline-start" />{t('ai.workspace.skills.title')}</InputGroupButton>
      : <DropdownMenuTrigger render={<InputGroupButton disabled={disabled} aria-label={t('ai.workspace.skills.title')} />}><BookOpenIcon data-icon="inline-start" />{t('ai.workspace.skills.title')}</DropdownMenuTrigger>}
    <DropdownMenuContent align="start" className="max-h-80 w-80 max-w-[calc(100vw-1rem)] overflow-y-auto">
      <DropdownMenuGroup>
        <DropdownMenuLabel>{t('ai.workspace.skills.title')}</DropdownMenuLabel>
        {loading && <DropdownMenuItem disabled>{t('ai.workspace.skills.loading')}</DropdownMenuItem>}
        {result?.status === 'stale' && <Alert><AlertDescription>{t('ai.workspace.skills.stale')}</AlertDescription></Alert>}
        {(error || result?.status === 'unavailable') && <Alert><AlertDescription>{error ?? t('ai.workspace.skills.unavailable')}</AlertDescription></Alert>}
        {result && result.entries.length === 0 && <DropdownMenuItem disabled>{t('ai.workspace.skills.empty')}</DropdownMenuItem>}
        {result?.entries.map((skill) => <DropdownMenuItem key={skill.name} onClick={() => onSelect(skill.name)} className="flex-col items-start gap-1">
          <span>/{skill.name} {!skill.modelInvocable && <Badge variant="secondary">{t('ai.workspace.skills.userOnly')}</Badge>}</span>
          <span className="whitespace-normal text-muted-foreground">{skill.description}</span>
        </DropdownMenuItem>)}
        {result?.diagnostics.map((d, i) => <DropdownMenuItem key={i} disabled className="whitespace-normal">{d.path}: {d.message}</DropdownMenuItem>)}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
  <Dialog open={projectOpen} onOpenChange={setProjectOpen}>
    <DialogContent onClick={(event) => event.stopPropagation()} finalFocus={false}>
      <DialogTitle>{t('ai.workspace.skills.root')}</DialogTitle>
      <DialogDescription>{targetLabel}</DialogDescription>
      <AiProjectDirectoryInput value={root} onChange={setRoot} onConfirm={() => void refresh()} loading={loading} />
      {error && <Alert><AlertDescription>{error}</AlertDescription></Alert>}
    </DialogContent>
  </Dialog></>;
}
