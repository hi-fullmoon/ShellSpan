import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

afterEach(cleanup);

describe('composer disclaimer', () => {
  it.each(['zh-CN', 'en-US'] as const)('shows a subtle centered notice below the input in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const { container } = render(<AiComposerSeat phase="active" status="idle" />);
    const notice = screen.getByText(locale === 'zh-CN'
      ? '内容由AI生成，请仔细甄别'
      : 'AI-generated content. Please review carefully.');
    expect(notice).toHaveClass('text-center', 'text-[11px]', 'text-[var(--ai-text-caption)]', 'opacity-70', 'shrink-0');
    expect(container.querySelector('.ai-composer-input-anchor')?.nextElementSibling).toBe(notice);
    expect(notice).toBeVisible();
  });
});
