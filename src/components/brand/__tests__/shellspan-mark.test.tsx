import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ShellSpanGlyph, ShellSpanMark } from '@/components/brand/shellspan-mark';

describe('ShellSpanMark', () => {
  it('renders in grayscale when multiple marks appear together', () => {
    const { container } = render(<><ShellSpanMark /><ShellSpanMark /></>);
    const marks = [...container.querySelectorAll('svg')];

    expect(marks).toHaveLength(2);
    const gradientIds: string[] = [];
    for (const mark of marks) {
      const gradient = mark.querySelector('linearGradient');
      expect(gradient).not.toBeNull();
      gradientIds.push(gradient!.id);
      expect(mark.querySelector('rect')).toHaveAttribute('fill', '#505050');
      expect([...mark.querySelectorAll('stop')].map((stop) => stop.getAttribute('stop-color')))
        .toEqual(['#D3D3D3', '#858585']);
      const paints = [
        mark.querySelector('rect')?.getAttribute('fill'),
        mark.querySelector('path')?.getAttribute('stroke'),
        ...[...mark.querySelectorAll('stop')].map((stop) => stop.getAttribute('stop-color')),
      ]
        .filter((value): value is string => value !== null);

      expect(mark.querySelectorAll('path')).toHaveLength(2);
      expect(mark.querySelectorAll('path')[1]).toHaveAttribute('stroke', `url(#${gradient!.id})`);
      expect(paints).toHaveLength(4);
      for (const paint of paints) {
        expect(paint).toMatch(/^#[\dA-F]{6}$/);
        expect(paint.slice(1, 3)).toBe(paint.slice(3, 5));
        expect(paint.slice(3, 5)).toBe(paint.slice(5, 7));
      }
    }
    expect(new Set(gradientIds).size).toBe(marks.length);
  });

  it('uses the same folded path for the compact glyph', () => {
    const { container } = render(<><ShellSpanGlyph /><ShellSpanMark /></>);
    const [glyph, mark] = [...container.querySelectorAll('svg')];

    expect(glyph.querySelector('path')).toHaveAttribute('stroke', 'currentColor');
    expect([...glyph.querySelectorAll('path')].map((path) => path.getAttribute('d')))
      .toEqual([...mark.querySelectorAll('path')].map((path) => path.getAttribute('d')));
  });
});
