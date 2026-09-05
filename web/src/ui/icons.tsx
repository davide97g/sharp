// Shared icon registry. Convention: 24-unit viewBox, currentColor stroke,
// stroke-width 2, round caps/joins, aria-hidden. Import glyphs from here rather
// than hand-rolling a local `function XIcon()` for a shape that lives here.
import type { ReactNode, SVGProps } from 'react'

export interface IconProps {
  size?: number
  strokeWidth?: number
  className?: string
}

function Icon({ size = 16, strokeWidth = 2, className, children }: IconProps & { children: ReactNode }) {
  const props: SVGProps<SVGSVGElement> = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    className,
  }
  return <svg {...props}>{children}</svg>
}

export function CloseIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  )
}

export function ChevronDownIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  )
}

export function ChevronRightIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  )
}

export function ChevronLeftIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="m15 18-6-6 6-6" />
    </Icon>
  )
}

export function ChevronUpIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="m18 15-6-6-6 6" />
    </Icon>
  )
}

export function PlusIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  )
}

export function SearchIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Icon>
  )
}

export function CheckIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  )
}

export function TrashIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </Icon>
  )
}

export function PencilIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Icon>
  )
}

export function CopyIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  )
}

export function ExternalLinkIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M15 3h6v6M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Icon>
  )
}

export function ArrowRightIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M5 12h14M12 5l7 7-7 7" />
    </Icon>
  )
}

export function BellIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </Icon>
  )
}

export function UserIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Icon>
  )
}

export function HashIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
    </Icon>
  )
}

export function CalendarIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </Icon>
  )
}

export function ClockIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Icon>
  )
}

export function WarningIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Icon>
  )
}

export function InfoIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </Icon>
  )
}

export function SparkleIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />
    </Icon>
  )
}

export function DotsIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Icon>
  )
}

// Object glyphs — the shapes the mode rail uses for each kind of thing you can
// open. They live here so surfaces that mix kinds (home recents, search) draw
// the same doc/canvas/board/conversation as the rail does.
export function DocIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h6" />
    </Icon>
  )
}

export function CanvasIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <circle cx="16.5" cy="7.5" r="3.5" />
      <path d="M7.5 21 3 14h9z" />
    </Icon>
  )
}

export function BoardIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="4" y="4" width="4" height="16" rx="1" />
      <rect x="10" y="4" width="4" height="11" rx="1" />
      <rect x="16" y="4" width="4" height="7" rx="1" />
    </Icon>
  )
}

export function MessageIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M7 18.5 3.5 21l1-4.2A8 8 0 1 1 7 18.5Z" />
      <path d="M8 10h8M8 14h5" />
    </Icon>
  )
}

export function SendIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </Icon>
  )
}

// Brand mark, not a stroke glyph: GitHub's octocat only reads as itself filled.
export function GithubIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 1.5a10.5 10.5 0 0 0-3.32 20.46c.53.1.72-.23.72-.5v-1.78c-2.92.64-3.54-1.4-3.54-1.4-.48-1.22-1.17-1.55-1.17-1.55-.95-.65.07-.64.07-.64 1.06.08 1.62 1.09 1.62 1.09.93 1.6 2.45 1.14 3.05.87.09-.68.36-1.14.66-1.4-2.33-.27-4.78-1.17-4.78-5.2 0-1.15.41-2.09 1.08-2.83-.11-.27-.47-1.34.1-2.79 0 0 .88-.28 2.88 1.07a9.9 9.9 0 0 1 5.24 0c2-1.35 2.88-1.07 2.88-1.07.57 1.45.21 2.52.1 2.79.67.74 1.08 1.68 1.08 2.83 0 4.04-2.46 4.93-4.8 5.19.37.32.7.95.7 1.92v2.85c0 .28.19.61.73.5A10.5 10.5 0 0 0 12 1.5z" />
    </svg>
  )
}

export function ExpandIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </Icon>
  )
}

export function ShrinkIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M14 10h6V4M10 14H4v6M20 4l-6 6M4 20l6-6" />
    </Icon>
  )
}

// Re-export the pre-existing chrome glyphs so the registry is the one import site.
export { GearIcon, LockIcon, EyeIcon, EyeOffIcon } from '../components/icons'
