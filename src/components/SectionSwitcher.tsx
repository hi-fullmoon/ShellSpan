import { useLayoutEffect, useRef, useState } from 'react';
import type { AppSection } from '../types';

interface SectionSwitcherProps {
  value: AppSection;
  onChange: (section: AppSection) => void;
}

const SECTIONS: { value: AppSection; label: string }[] = [
  { value: 'my', label: '我的' },
  { value: 'sftp', label: '文件传输' },
  { value: 'terminal', label: '终端' },
];

export function SectionSwitcher({ value, onChange }: SectionSwitcherProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Map<AppSection, HTMLButtonElement>>(new Map());
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const activeButton = buttonRefs.current.get(value);
    if (!container || !activeButton) return;
    const containerRect = container.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    setIndicator({
      left: buttonRect.left - containerRect.left,
      width: buttonRect.width,
    });
  }, [value]);

  return (
    <div ref={containerRef} className="relative flex h-full items-center gap-0.5" role="tablist" aria-label="应用板块">
      {SECTIONS.map((section) => {
        const active = value === section.value;
        return (
          <button
            key={section.value}
            ref={(el) => {
              if (el) buttonRefs.current.set(section.value, el);
            }}
            aria-selected={active}
            className={[
              'title-bar-btn relative z-10 flex h-7 !w-auto items-center justify-center rounded-xl px-3 text-sm font-medium whitespace-nowrap transition',
              active ? '!text-[var(--app-primary-text)]' : 'text-[var(--app-text-muted)] hover:text-[var(--app-text-soft)]',
            ].join(' ')}
            onClick={() => onChange(section.value)}
            role="tab"
            type="button"
          >
            {section.label}
          </button>
        );
      })}
      <div
        className="pointer-events-none absolute top-1/2 h-7 -translate-y-1/2 rounded-[8px] bg-[var(--app-primary-bg)] transition-all duration-300 ease-out"
        style={{ left: indicator.left, width: indicator.width }}
      />
    </div>
  );
}
