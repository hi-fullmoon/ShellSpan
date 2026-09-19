import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { createAiComposerState, reduceAiComposer } from '@/lib/ai/composer-machine';
import { withOptimisticConversationNodes } from '@/lib/ai/optimistic-submission';
import { agentSessionBaselineView } from '@/test/agent-session-baseline-page';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import { useImageDraft } from '@/components/ai/workspace/use-image-draft';
import { readImageDraft } from '@/lib/ai/image-drafts';

/** Exercise the production editor, submit reducer and workspace without a transport. */
export function SubmissionCheck({ queue, history, imageOwner }: { queue: boolean; history: string; imageOwner?: string }) {
  const baseline = useMemo(() => agentSessionBaselineView(agentSessionBaselineScenarios.pagination), []);
  const status = queue ? 'running' : 'idle';
  const [composer, setComposer] = useState(() => createAiComposerState({
    sessionId: baseline.summary.id, runtimeStatus: status,
  }));
  const restoreText = useCallback((value: string) => {
    setComposer((current) => reduceAiComposer(current, { type: 'draft.changed', value }).state);
  }, []);
  const imageDraft = useImageDraft(imageOwner ?? 'submission-check:text', composer.draft, restoreText);
  // Use repository Markdown to exercise a genuinely overflowing transcript.
  const [committed, setCommitted] = useState(() => baseline.nodes.map((node) => (
    node.kind === 'assistantMessage'
      ? { ...node, blocks: [{ type: 'text' as const, text: history }] }
      : node
  )));
  const nodes = withOptimisticConversationNodes(committed, queue ? [] : composer.pendingSubmissions.map((item) => ({
    ...item, scopeKey: 'submission-check', expectedNextSeq: null, delivery: 'pending' as const,
  })), 'submission-check', baseline.summary.id);
  useEffect(() => {
    Object.assign(window, { submissionCheck: {
      imageReady: Boolean(imageDraft.draft?.images.length),
      imageBusy: imageDraft.busy,
      imageError: imageDraft.error,
      pending: imageOwner ? Number(Boolean(imageDraft.submittedOperationId)) : composer.pendingSubmissions.length,
      acknowledge() {
        setCommitted(nodes.map((node) => node.kind === 'userMessage' ? { ...node, delivery: 'committed' } : node));
        for (const item of composer.pendingSubmissions) {
          setComposer((current) => reduceAiComposer(current, {
            type: 'submit.committed', clientOperationId: item.clientOperationId,
          }).state);
        }
      },
    } });
  }, [composer, nodes, imageOwner, imageDraft.draft, imageDraft.submittedOperationId, imageDraft.busy, imageDraft.error]);
  return <main className="ai-panel-shell h-dvh w-full min-w-0" data-ai-scope="workbench">
    <AiWorkspaceRoot
      scope="workbench" canStartAgent composerState={composer}
      hasImages={Boolean(imageDraft.draft?.images.length)}
      imageBusy={imageDraft.busy} imageLocked={imageDraft.locked}
      imageSubmissionId={imageDraft.submittedOperationId}
      view={{ ...baseline, nodes, status, summary: { ...baseline.summary, status },
        snapshot: { kind: 'agent', value: { ...baseline.snapshot.value, status, ended: false } } }}
      onDraftChange={(value) => setComposer((current) => reduceAiComposer(current, { type: 'draft.changed', value }).state)}
      onSubmitGesture={(gesture, accelerated) => {
        if (imageOwner) {
          // Real draft persistence and image decoding; no native IPC or provider
          // transport is substituted by this UI integration surface.
          void imageDraft.send(async () => ({
            id: crypto.randomUUID(), sessionId: baseline.summary.id, mode: queue ? 'nextTurn' : 'start',
          }), async (value) => {
            const stored = await readImageDraft(value.owner);
            if (stored?.operation?.id !== value.operation?.id) throw new Error('Image operation was not persisted');
            for (const image of value.images) {
              const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
              const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mediaType }));
              if (!bitmap.width || !bitmap.height) throw new Error('Image could not be decoded');
              bitmap.close();
            }
          }, () => restoreText(''));
        } else {
          setComposer((current) => reduceAiComposer(current, {
            type: 'submit.requested', gesture, accelerated, clientOperationId: crypto.randomUUID(),
            now: Date.now(), hasProvider: true, canCreateSession: true,
          }).state);
        }
      }}
    />
  </main>;
}
