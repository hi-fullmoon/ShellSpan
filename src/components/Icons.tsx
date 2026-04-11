import type { SVGProps } from "react";

function baseProps(props: SVGProps<SVGSVGElement>) {
  return {
    fill: "none",
    height: 14,
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
    viewBox: "0 0 16 16",
    width: 14,
    ...props,
  };
}

export function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <rect x="3.5" y="7" width="9" height="6" rx="1.8" />
      <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}

export function KeyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="5.5" cy="8" r="2.5" />
      <path d="M8 8h5" />
      <path d="M11 8v2" />
      <path d="M13 8v1.5" />
    </svg>
  );
}

export function FolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <path d="M2.5 5.5h11v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
      <path d="M2.5 5.5V4.7a1 1 0 0 1 1-1h2l1 1h5a1 1 0 0 1 1 1v.8" />
    </svg>
  );
}

export function FileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <path d="M5 2.5h4l2 2v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z" />
      <path d="M9 2.5v2h2" />
    </svg>
  );
}

export function LinkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <path d="M6.2 9.8 4.8 11.2a2 2 0 1 1-2.8-2.8l1.4-1.4" />
      <path d="M9.8 6.2 11.2 4.8a2 2 0 1 1 2.8 2.8l-1.4 1.4" />
      <path d="m6 10 4-4" />
    </svg>
  );
}

export function DotsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="4" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ArrowLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <path d="M12.5 8h-9" />
      <path d="m6 4.5-3.5 3.5L6 11.5" />
    </svg>
  );
}

export function ArrowRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <path d="M3.5 8h9" />
      <path d="m10 4.5 3.5 3.5-3.5 3.5" />
    </svg>
  );
}

export function ArrowUpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <path d="M8 12.5v-9" />
      <path d="M4.5 6 8 2.5 11.5 6" />
    </svg>
  );
}

export function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <path d="M12.5 6a4.5 4.5 0 1 0 1 3" />
      <path d="M12.5 3.5V6h-2.5" />
    </svg>
  );
}

export function PinIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <path d="M5 3.5h6" />
      <path d="M6 3.5v3l-1.5 1.5v1h7v-1L10 6.5v-3" />
      <path d="M8 9v3.5" />
    </svg>
  );
}

export function StarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <path d="m8 2.5 1.6 3.2 3.6.5-2.6 2.5.6 3.6L8 10.7 4.8 12.3l.6-3.6L2.8 6.2l3.6-.5Z" />
    </svg>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps(props)}>
      <path d="m5 5 6 6" />
      <path d="m11 5-6 6" />
    </svg>
  );
}
