import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AiConversationNodeList } from '@/components/ai/workspace/ai-conversation-node-seat';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiConversationNode, AiConversationNodeOf } from '@/lib/ai/conversation-node';
import type { AgentSessionEvent } from '@/types/agent-session';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import capture from '@/test/fixtures/agent-skills-runtime.json';
import failureCapture from '@/test/fixtures/skill-load-failure.json';

afterEach(cleanup);

describe('skill invocation content layout', () => {
  it.each(['zh-CN', 'en-US'] as const)('labels recorded skill load failures in %s', async locale => {
    await initI18n(locale);
    useAppStore.setState({ locale });
    const node = projectAgentChatNodes(failureCapture as unknown as readonly AgentSessionEvent[])
      .flatMap<AiConversationNode>(item => item.kind === 'turnProcess' ? item.children : [item])
      .find((item): item is AiConversationNodeOf<'contextInjection'> =>
        item.kind === 'contextInjection' && item.provenance.kind === 'skill-invocation');
    if (!node || node.loadedSkill || !node.content) throw new Error('Recorded skill load failure is missing');
    render(<AiConversationNodeList nodes={[node]} />);
    await userEvent.setup().click(screen.getByRole('button', { name: locale === 'zh-CN' ? '技能调用' : 'Skill invocation' }));
    const title = locale === 'zh-CN' ? '加载失败' : 'Failed to load';
    expect(screen.getByText(title).closest('.ai-io-label')).toBeInTheDocument();
    const viewport = screen.getByLabelText(title);
    expect(viewport.querySelector('pre')?.textContent).toBe(node.content);
    expect(screen.queryByText(locale === 'zh-CN' ? '完整指令' : 'Full instructions')).not.toBeInTheDocument();
    const copy = screen.getByRole('button', { name: locale === 'zh-CN' ? '复制' : 'Copy' });
    expect(copy.closest('[data-ai-copy-region]')).toContainElement(viewport);
  });

  it.each(['zh-CN', 'en-US'] as const)('uses the tool content surface in %s', async locale => {
    await initI18n(locale);
    useAppStore.setState({ locale });
    const node = projectAgentChatNodes(capture as unknown as readonly AgentSessionEvent[])
      .flatMap<AiConversationNode>(item => item.kind === 'turnProcess' ? item.children : [item])
      .find((item): item is AiConversationNodeOf<'contextInjection'> =>
        item.kind === 'contextInjection' && Boolean(item.loadedSkill));
    if (!node?.loadedSkill) throw new Error('Recorded skill invocation is missing');
    const { container } = render(<AiConversationNodeList nodes={[node]} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: locale === 'zh-CN' ? '技能调用' : 'Skill invocation' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    const title = locale === 'zh-CN' ? '完整指令' : 'Full instructions';
    expect(screen.getByText(title).closest('.ai-io-label')).toBeInTheDocument();
    const viewport = screen.getByLabelText(title);
    expect(viewport).toHaveAttribute('data-slot', 'scroll-area-viewport');
    expect(viewport.closest('.ai-tool-scroll-area')).toHaveClass('max-h-65');
    const content = viewport.querySelector('pre');
    expect(content).toHaveClass('ai-content-code', 'whitespace-pre-wrap');
    expect(content?.textContent).toContain(node.loadedSkill.instructions);
    expect(content?.textContent).toContain(JSON.stringify(node.loadedSkill.provenance, null, 2));
    expect(content?.textContent).toContain(`renderedHash: ${node.loadedSkill.renderedHash}`);
    expect(container.querySelector('.ai-semantic-note-body')).toBeNull();
    const copy = screen.getByRole('button', { name: locale === 'zh-CN' ? '复制' : 'Copy' });
    expect(copy.closest('[data-ai-copy-region]')).toContainElement(viewport);
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard(' ');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});
