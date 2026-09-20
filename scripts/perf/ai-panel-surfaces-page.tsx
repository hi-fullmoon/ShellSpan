import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiComposerSeat } from '../../src/components/ai/workspace/ai-composer-seat';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { builtinSkillPreview } from '../../src/lib/ai/builtin-skills';
import { createAiComposerState } from '../../src/lib/ai/composer-machine';
import type { AiPendingApproval } from '../../src/lib/ai/session-adapter';
import { initI18n } from '../../src/locales';
import { useAppStore } from '../../src/stores/appStore';
import '../../src/styles/base.css';
import '../../src/components/ai/styles/styles.css';

const params = new URLSearchParams(location.search);
const locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';
useAppStore.setState({ locale });
await initI18n(locale);
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
const long = params.has('long');
const approval: AiPendingApproval = {
  sessionId: 'surface-preview', turnId: 'turn-1', stepId: 'step-1', requestId: 'request-1',
  callId: 'call-1', approvalId: 'approval-1', toolName: 'exec_command',
  risk: 'stateChange', effect: 'stateChange', prompt: null, reason: null,
  expiresAtUnixMs: 2_000, evidenceRefs: [],
  target: { kind: 'local', targetId: 'local', label: 'PowerShell' },
  arguments: {
    command: long
      ? Array.from({ length: 60 }, (_, i) => `Write-Output 'Memory sample ${i + 1}: ${'x'.repeat(160)}'`).join('\n')
      : 'Get-CimInstance Win32_OperatingSystem |\n  Select-Object Caption, TotalVisibleMemorySize, FreePhysicalMemory',
    explanation: locale === 'zh-CN'
      ? '收集操作系统与内存信息，用于排查当前电脑的性能问题。'
      : 'Collect operating system and memory information to investigate this computer’s performance.',
  },
};

function Page() {
  const [decisions, setDecisions] = useState(0);
  const skills = params.get('screen') === 'skills';
  return <TooltipProvider>
    <main className="ai-panel-shell ai-workspace-root @container/ai-workspace ml-auto flex h-dvh max-w-full min-w-0 flex-col" style={{ width: Number(params.get('panelWidth') ?? 720) }}>
      <header className="h-10 shrink-0 px-4 py-2">AI · ShellSpan</header>
      <div data-slot="ai-workspace-body" className="flex min-h-0 flex-1 flex-col justify-end">
        <AiComposerSeat phase="active" mode="agent" status={skills ? 'idle' : 'waiting'}
          composerState={skills ? undefined : createAiComposerState({ phase: 'waitingApproval', runtimeStatus: 'waiting', waitingApproval: true })}
          pendingApproval={skills ? null : approval}
          approvalError={params.has('error') ? 'Approval failed. Please try again.' : null}
          onApprove={() => setDecisions(value => value + 1)}
          onReject={() => setDecisions(value => value + 1)}
          onListSkills={async () => builtinSkillPreview} />
      </div>
      <output hidden data-decisions>{decisions}</output>
    </main>
  </TooltipProvider>;
}
createRoot(document.getElementById('root')!).render(<Page />);
