// The design-system barrel. Import primitives from here:
//   import { Button, Modal, Menu, MenuItem, EmptyState } from '../ui'
// Never hand-roll a pattern that already lives in ui/.

// ── Utilities ───────────────────────────────────────────────────────────────
export { cn } from './cn'
export { useDismiss } from './useDismiss'

// ── Atoms ───────────────────────────────────────────────────────────────────
export * from './Spinner'
export * from './IconButton'
export * from './Button'
export * from './Input'
export * from './Textarea'
export * from './Select'
export * from './SearchInput'
export * from './Field'
export * from './SectionLabel'
export * from './Heading'
export * from './Badge'
export * from './Tag'
export * from './Kbd'
export * from './Skeleton'
export * from './Divider'
export * from './Tooltip'
export * from './icons'

// ── Composites ──────────────────────────────────────────────────────────────
export * from './Overlay'
export * from './Modal'
export * from './ModalFooter'
export * from './SlideOver'
export * from './PanelHeader'
export * from './Popover'
export * from './Menu'
export * from './Card'
export * from './EmptyState'
export * from './Banner'
export * from './Tabs'
export * from './ChoiceCard'
export * from './ListRow'
export * from './Toggle'

// ── Adjacent, already-centralized helpers (re-exported for convenience) ──────
export { Avatar } from '../components/Avatar'
export { toastError, toastInfo, toastSuccess } from '../lib/toast'
