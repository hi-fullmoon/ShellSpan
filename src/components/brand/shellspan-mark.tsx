import React from 'react';

import { cn } from '@/lib/utils';

export type ShellSpanIconProps = React.ComponentProps<'svg'>;

const SPAN_PATH = 'M704 318H430C349 318 302 353 302 418C302 474 333 498 410 528L610 604C687 635 724 662 724 712C724 769 679 786 608 786H314';
const FOLD_PATH = 'M410 528L610 604';

/** Product glyph shared by compact ShellSpan surfaces. */
export const ShellSpanGlyph = React.forwardRef<SVGSVGElement, ShellSpanIconProps>(
  ({ className, ...props }, ref) => (
    <svg
      ref={ref}
      aria-hidden="true"
      className={cn('shrink-0', className)}
      fill="none"
      viewBox="0 0 1024 1024"
      {...props}
    >
      <path d={SPAN_PATH} stroke="currentColor" strokeLinecap="square" strokeLinejoin="round" strokeWidth="100" />
      <path d={FOLD_PATH} stroke="currentColor" strokeOpacity=".6" strokeWidth="100" />
    </svg>
  ),
);
ShellSpanGlyph.displayName = 'ShellSpanGlyph';

/** Standalone ShellSpan application mark. */
export const ShellSpanMark = React.forwardRef<SVGSVGElement, ShellSpanIconProps>(
  ({ className, ...props }, ref) => {
    const foldGradientId = React.useId();

    return (
      <svg
        ref={ref}
        aria-hidden="true"
        className={cn('shrink-0', className)}
        fill="none"
        viewBox="0 0 1024 1024"
        {...props}
      >
        <defs>
          <linearGradient id={foldGradientId} x1="410" y1="528" x2="610" y2="604" gradientUnits="userSpaceOnUse">
            <stop stopColor="#D3D3D3" />
            <stop offset="1" stopColor="#858585" />
          </linearGradient>
        </defs>
        <rect x="32" y="32" width="960" height="960" rx="220" fill="#505050" />
        <path d={SPAN_PATH} stroke="#F4F4F4" strokeLinecap="square" strokeLinejoin="round" strokeWidth="100" />
        <path d={FOLD_PATH} stroke={`url(#${foldGradientId})`} strokeWidth="100" />
      </svg>
    );
  },
);
ShellSpanMark.displayName = 'ShellSpanMark';
