// Choco design icon set — ported from the Claude-Design handoff (choco-core.jsx
// ICON map). Inline SVGs (currentColor stroke) so they inherit the .d-choco
// token colors. Named exports only (no default export).

import type { ReactElement } from 'react';

interface IcProps {
  readonly size?: number;
  readonly strokeWidth?: number;
  readonly fill?: string;
  readonly children: ReactElement;
}

function Ic(props: IcProps): ReactElement {
  const { size = 18, strokeWidth = 1.7, fill = 'none', children } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconPlus(): ReactElement {
  return (
    <Ic size={16} strokeWidth={2}>
      <path d="M12 5v14M5 12h14" />
    </Ic>
  );
}

export function IconSend(): ReactElement {
  return (
    <Ic size={18} strokeWidth={2}>
      <path d="M5 12h13M12 6l6 6-6 6" />
    </Ic>
  );
}

export function IconChevron(): ReactElement {
  return (
    <Ic size={15} strokeWidth={2}>
      <path d="M9 6l6 6-6 6" />
    </Ic>
  );
}

export function IconHash(): ReactElement {
  return (
    <Ic size={15} strokeWidth={1.6}>
      <path d="M6 9h12M5 15h12M10 4L8 20M16 4l-2 16" />
    </Ic>
  );
}

export function IconBell(): ReactElement {
  return (
    <Ic size={16}>
      <>
        <path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z" />
        <path d="M10.5 20a2 2 0 003 0" />
      </>
    </Ic>
  );
}

export function IconPanel(): ReactElement {
  return (
    <Ic size={15}>
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </>
    </Ic>
  );
}

export function IconGear(): ReactElement {
  return (
    <Ic size={15}>
      <>
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 3v2.5M12 18.5V21M21 12h-2.5M5.5 12H3M18 6l-1.8 1.8M7.8 16.2L6 18M18 18l-1.8-1.8M7.8 7.8L6 6" />
      </>
    </Ic>
  );
}

export function IconStop(): ReactElement {
  return (
    <Ic size={13} strokeWidth={0} fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </Ic>
  );
}

export function IconTerminal(): ReactElement {
  return (
    <Ic size={15}>
      <>
        <rect x="3" y="4.5" width="18" height="15" rx="2" />
        <path d="M7 9.5l3 2.5-3 2.5M12.5 15H16" />
      </>
    </Ic>
  );
}
