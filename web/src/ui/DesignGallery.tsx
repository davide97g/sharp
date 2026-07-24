// Dev-only design-system catalog. Route: /design (import.meta.env.DEV gate in App.tsx).
// The living companion to docs/DESIGN_SYSTEM.md — every primitive rendered live so
// humans can see variants, spacing, and theme behaviour in one scroll.
//
// Import discipline: ONLY from the barrel ('./index'), lib/boardColors, and react.
import {
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import {
  cn,
  Spinner,
  IconButton,
  Button,
  Input,
  Textarea,
  Select,
  SearchInput,
  Field,
  SectionLabel,
  Heading,
  Badge,
  CountBadge,
  Tag,
  Kbd,
  Skeleton,
  EditorSkeleton,
  Divider,
  Tooltip,
  Card,
  EmptyState,
  Banner,
  Tabs,
  ChoiceCard,
  ListRow,
  Toggle,
  Modal,
  ModalFooter,
  SlideOver,
  Popover,
  PanelHeader,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  toastError,
  toastInfo,
  toastSuccess,
  // icons
  CloseIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  PlusIcon,
  SearchIcon,
  CheckIcon,
  TrashIcon,
  PencilIcon,
  CopyIcon,
  ExternalLinkIcon,
  ArrowRightIcon,
  BellIcon,
  UserIcon,
  HashIcon,
  CalendarIcon,
  ClockIcon,
  WarningIcon,
  InfoIcon,
  SparkleIcon,
  DotsIcon,
  SendIcon,
  GearIcon,
  LockIcon,
  EyeIcon,
  EyeOffIcon,
  type IconProps,
} from './index'
import { PALETTE_KEYS, BOARD_COLORS } from '../lib/boardColors'

// ── Local helpers ────────────────────────────────────────────────────────────

/** A tiny monospace code hint under an example. */
function CodeHint({ children }: { children: ReactNode }) {
  return <div className="mt-2 font-mono text-2xs text-text-faint">{children}</div>
}

/** One demo block: a caption + rendered example + optional code hint. */
function Demo({
  label,
  code,
  children,
  className,
}: {
  label?: ReactNode
  code?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      {label && <div className="mb-2 text-2xs font-medium uppercase tracking-wider text-text-faint">{label}</div>}
      <div className="flex flex-wrap items-center gap-3">{children}</div>
      {code && <CodeHint>{code}</CodeHint>}
    </div>
  )
}

/** A catalog section: sticky-nav anchor + heading + usage note + a Card of examples. */
function Section({
  id,
  title,
  note,
  children,
}: {
  id: string
  title: string
  note: ReactNode
  children: ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <Heading level={2} className="mb-1">
        {title}
      </Heading>
      <p className="mb-4 max-w-2xl text-sm text-text-dim">{note}</p>
      <Card padding="lg" className="flex flex-col gap-8">
        {children}
      </Card>
    </section>
  )
}

// ── Section 1: Tokens ─────────────────────────────────────────────────────────

const TOKEN_GROUPS: { group: string; tokens: string[] }[] = [
  { group: 'Surfaces', tokens: ['ink', 'panel', 'panel-2', 'border', 'border-soft'] },
  { group: 'Accent', tokens: ['accent', 'accent-hover', 'accent-soft'] },
  { group: 'Text', tokens: ['text', 'text-dim', 'text-faint'] },
  { group: 'Danger', tokens: ['danger', 'danger-hover', 'danger-soft', 'danger-fg'] },
  { group: 'Success', tokens: ['success', 'success-soft', 'success-fg'] },
  { group: 'Warning', tokens: ['warning', 'warning-soft', 'warning-fg'] },
]

/** Reads a --color-<name> var live so it retints when the theme preset changes. */
function Swatch({ name, themeKey }: { name: string; themeKey: string }) {
  const varName = `--color-${name}`
  const [hex, setHex] = useState('')
  useEffect(() => {
    setHex(getComputedStyle(document.documentElement).getPropertyValue(varName).trim())
  }, [varName, themeKey])
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="h-14 w-full rounded-lg border border-border"
        style={{ background: `var(${varName})` }}
      />
      <div className="text-2xs font-medium text-text">{name}</div>
      <div className="font-mono text-3xs text-text-faint">{varName}</div>
      <div className="font-mono text-3xs text-text-faint">{hex || '—'}</div>
    </div>
  )
}

const THEMES: { value: string; label: string }[] = [
  { value: '', label: 'Default (purple)' },
  { value: 'slack', label: 'Slack (aubergine)' },
  { value: 'teams', label: 'Teams (indigo)' },
  { value: 'one-piece', label: 'One Piece' },
]

function TokensSection() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || '')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <Section
      id="tokens"
      title="Tokens"
      note={
        <>
          Every colour is a CSS variable in <code className="font-mono text-xs">index.css</code>, retinted by 4 theme
          presets. Never hard-code hex — use the semantic utility (<code className="font-mono text-xs">bg-panel</code>,{' '}
          <code className="font-mono text-xs">text-danger-fg</code>). Switch the preset to watch swatches (and this whole
          page) retint live.
        </>
      }
    >
      <Demo label="Theme preset" code="document.documentElement.dataset.theme = '' | 'slack' | 'teams' | 'one-piece'">
        <Select uiSize="sm" value={theme} onChange={(e) => setTheme(e.target.value)} className="w-56">
          {THEMES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </Demo>
      {TOKEN_GROUPS.map((g) => (
        <div key={g.group}>
          <SectionLabel className="mb-3">{g.group}</SectionLabel>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-5">
            {g.tokens.map((t) => (
              <Swatch key={t} name={t} themeKey={theme} />
            ))}
          </div>
        </div>
      ))}
    </Section>
  )
}

// ── Section 2: Typography ──────────────────────────────────────────────────────

const TYPE_SCALE: { cls: string; note: string }[] = [
  { cls: 'text-3xs', note: '10px · micro / badges' },
  { cls: 'text-2xs', note: '11px · captions / metadata' },
  { cls: 'text-xs', note: 'dense body' },
  { cls: 'text-sm', note: 'default body & controls' },
  { cls: 'text-base', note: 'roomy body' },
  { cls: 'text-lg', note: 'panel headings' },
  { cls: 'text-xl', note: 'page titles' },
  { cls: 'text-2xl', note: 'page titles' },
  { cls: 'text-3xl', note: 'hero' },
]

function TypographySection() {
  return (
    <Section
      id="typography"
      title="Typography"
      note={
        <>
          One scale from <code className="font-mono text-xs">text-3xs</code> to{' '}
          <code className="font-mono text-xs">text-3xl</code>. Emphasis is{' '}
          <code className="font-mono text-xs">font-semibold</code>; soft emphasis{' '}
          <code className="font-mono text-xs">font-medium</code>. Never use raw{' '}
          <code className="font-mono text-xs">text-[10px]</code>.
        </>
      }
    >
      <div>
        <SectionLabel className="mb-3">Scale</SectionLabel>
        <div className="flex flex-col gap-3">
          {TYPE_SCALE.map((t) => (
            <div key={t.cls} className="flex items-baseline gap-4">
              <span className={cn(t.cls, 'font-semibold text-text')}>The quick brown fox</span>
              <span className="font-mono text-2xs text-text-faint">{t.cls}</span>
              <span className="text-2xs text-text-faint">{t.note}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel className="mb-3">Heading levels</SectionLabel>
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline gap-4">
            <Heading level={1}>Page title</Heading>
            <CodeHint>{'<Heading level={1}>'}</CodeHint>
          </div>
          <div className="flex items-baseline gap-4">
            <Heading level={2}>Panel heading</Heading>
            <CodeHint>{'<Heading level={2}>'}</CodeHint>
          </div>
          <div className="flex items-baseline gap-4">
            <Heading level={3}>Modal heading</Heading>
            <CodeHint>{'<Heading level={3}>'}</CodeHint>
          </div>
        </div>
      </div>

      <div>
        <SectionLabel className="mb-3">SectionLabel — tones × sizes</SectionLabel>
        <div className="flex flex-wrap items-center gap-6">
          <SectionLabel tone="faint" size="xs">Faint · xs</SectionLabel>
          <SectionLabel tone="faint" size="2xs">Faint · 2xs</SectionLabel>
          <SectionLabel tone="faint" size="3xs">Faint · 3xs</SectionLabel>
          <SectionLabel tone="accent" size="2xs">Accent · 2xs</SectionLabel>
        </div>
        <CodeHint>{'<SectionLabel tone="accent" size="2xs">'}</CodeHint>
      </div>

      <div>
        <SectionLabel className="mb-3">Text triad</SectionLabel>
        <div className="flex flex-col gap-1">
          <p className="text-sm text-text">text-text — primary body</p>
          <p className="text-sm text-text-dim">text-text-dim — secondary</p>
          <p className="text-sm text-text-faint">text-text-faint — metadata / hints</p>
        </div>
      </div>
    </Section>
  )
}

// ── Section 3: Buttons ─────────────────────────────────────────────────────────

const BTN_VARIANTS = ['primary', 'outline', 'ghost', 'danger'] as const
const BTN_SIZES = ['xs', 'sm', 'md', 'lg'] as const

function ButtonsSection() {
  return (
    <Section
      id="buttons"
      title="Buttons"
      note="4 variants × 4 sizes, plus pill, block, loading, disabled, and icon slots. Never inline a button recipe — extend Button."
    >
      {BTN_VARIANTS.map((v) => (
        <Demo key={v} label={v} code={`<Button variant="${v}" size="…">`}>
          {BTN_SIZES.map((s) => (
            <Button key={s} variant={v} size={s}>
              {s}
            </Button>
          ))}
        </Demo>
      ))}

      <Demo label="pill · block · loading · disabled" code={'<Button pill /> <Button loading /> <Button disabled />'}>
        <Button pill>Pill</Button>
        <Button loading>Saving</Button>
        <Button disabled>Disabled</Button>
        <Button variant="outline" disabled>
          Disabled
        </Button>
      </Demo>

      <Demo label="block" code={'<Button block>'}>
        <div className="w-full max-w-sm">
          <Button block>Full width</Button>
        </div>
      </Demo>

      <Demo label="with icons" code={'<Button iconLeft={<PlusIcon />} iconRight={<ArrowRightIcon />}>'}>
        <Button iconLeft={<PlusIcon />}>New</Button>
        <Button variant="outline" iconRight={<ArrowRightIcon />}>
          Next
        </Button>
        <Button variant="danger" iconLeft={<TrashIcon />}>
          Delete
        </Button>
      </Demo>

      <div>
        <SectionLabel className="mb-3">IconButton — variants × sizes × shapes</SectionLabel>
        <div className="flex flex-col gap-4">
          <Demo label="variants" code={'<IconButton variant="ghost|accent|danger" />'}>
            <IconButton label="Ghost" variant="ghost">
              <GearIcon />
            </IconButton>
            <IconButton label="Accent" variant="accent">
              <PlusIcon />
            </IconButton>
            <IconButton label="Danger" variant="danger">
              <TrashIcon />
            </IconButton>
          </Demo>
          <Demo label="sizes" code={'<IconButton size="sm|md|lg|xl" />'}>
            <IconButton label="Small" size="sm">
              <BellIcon />
            </IconButton>
            <IconButton label="Medium" size="md">
              <BellIcon />
            </IconButton>
            <IconButton label="Large" size="lg">
              <BellIcon />
            </IconButton>
            <IconButton label="XLarge" size="xl">
              <BellIcon />
            </IconButton>
          </Demo>
          <Demo label="shape + micro" code={'<IconButton shape="circle" micro />'}>
            <IconButton label="Square" shape="square">
              <SearchIcon />
            </IconButton>
            <IconButton label="Circle" shape="circle">
              <SearchIcon />
            </IconButton>
            <IconButton label="Micro spring" shape="circle" micro variant="accent">
              <SparkleIcon />
            </IconButton>
          </Demo>
        </div>
      </div>
    </Section>
  )
}

// ── Section 4: Form ─────────────────────────────────────────────────────────────

function FormSection() {
  const [toggleA, setToggleA] = useState(true)
  const [toggleB, setToggleB] = useState(false)
  return (
    <Section
      id="form"
      title="Form"
      note="Input / Textarea / Select share the same chrome (uiSize, surface, invalid). Field wraps a control with label/hint/error/required. One recipe, everywhere."
    >
      <Demo label="Input — sizes" code={'<Input uiSize="sm|md|lg" />'}>
        <Input uiSize="sm" placeholder="Small" className="w-40" />
        <Input uiSize="md" placeholder="Medium" className="w-40" />
        <Input uiSize="lg" placeholder="Large" className="w-40" />
      </Demo>

      <Demo label="Input — surfaces, invalid, prefix" code={'<Input surface="panel" invalid prefix="#" />'}>
        <Input surface="panel-2" placeholder="panel-2" className="w-40" />
        <Input surface="panel" placeholder="panel" className="w-40" />
        <Input invalid defaultValue="bad value" className="w-40" />
        <Input prefix="#" placeholder="channel-name" className="w-48" />
      </Demo>

      <Demo label="Textarea" code={'<Textarea uiSize="md" />'}>
        <Textarea placeholder="Multiple lines…" rows={3} className="w-72" />
      </Demo>

      <Demo label="Select" code={'<Select uiSize="md" />'}>
        <Select className="w-48">
          <option>Backlog</option>
          <option>In progress</option>
          <option>Done</option>
        </Select>
      </Demo>

      <Demo label="SearchInput" code={'<SearchInput variant="boxed|palette" />'}>
        <SearchInput variant="boxed" placeholder="Search (boxed)…" className="w-56" />
        <div className="w-56 rounded-lg border border-border bg-panel">
          <SearchInput variant="palette" placeholder="Search (palette)…" />
        </div>
      </Demo>

      <div>
        <SectionLabel className="mb-3">Field — label / hint / error / required</SectionLabel>
        <div className="grid max-w-xl grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Display name" hint="Shown to teammates" required>
            <Input placeholder="Ada Lovelace" />
          </Field>
          <Field label="Workspace URL" error="That slug is taken">
            <Input invalid defaultValue="acme" />
          </Field>
        </div>
        <CodeHint>{'<Field label="…" hint="…" error="…" required>'}</CodeHint>
      </div>

      <Demo label="Toggle" code={'<Toggle checked={v} onChange={setV} label="…" />'}>
        <div className="flex items-center gap-2">
          <Toggle checked={toggleA} onChange={setToggleA} label="Notifications" />
          <span className="text-sm text-text-dim">{toggleA ? 'On' : 'Off'}</span>
        </div>
        <div className="flex items-center gap-2">
          <Toggle checked={toggleB} onChange={setToggleB} label="Do not disturb" />
          <span className="text-sm text-text-dim">{toggleB ? 'On' : 'Off'}</span>
        </div>
        <Toggle checked={false} onChange={() => {}} label="Disabled" disabled />
      </Demo>
    </Section>
  )
}

// ── Section 5: Badges & chips ────────────────────────────────────────────────────

const BADGE_TONES = ['neutral', 'accent', 'success', 'warning', 'danger'] as const
const BADGE_VARIANTS = ['soft', 'solid', 'outline'] as const

function BadgesSection() {
  return (
    <Section
      id="badges"
      title="Badges & chips"
      note="Badge for status/labels (tone × variant). CountBadge for unread pills. Tag for board/task colours (keyed, never hex). Kbd for shortcuts."
    >
      {BADGE_VARIANTS.map((v) => (
        <Demo key={v} label={`Badge · ${v}`} code={`<Badge tone="…" variant="${v}">`}>
          {BADGE_TONES.map((t) => (
            <Badge key={t} tone={t} variant={v}>
              {t}
            </Badge>
          ))}
        </Demo>
      ))}

      <Demo label="uppercase" code={'<Badge uppercase>'}>
        <Badge tone="accent" uppercase>
          Beta
        </Badge>
        <Badge tone="warning" variant="solid" uppercase>
          Guest
        </Badge>
      </Demo>

      <Demo label="CountBadge" code={'<CountBadge count={120} muted />'}>
        <CountBadge count={3} />
        <CountBadge count={120} />
        <CountBadge count={7} muted />
      </Demo>

      <div>
        <SectionLabel className="mb-3">Tag — all boardColors keys</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {PALETTE_KEYS.map((k) => (
            <Tag key={k} colorKey={k}>
              {BOARD_COLORS[k].label}
            </Tag>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {PALETTE_KEYS.map((k) => (
            <Tag key={k} colorKey={k} withDot shape="pill">
              {BOARD_COLORS[k].label}
            </Tag>
          ))}
        </div>
        <CodeHint>{'<Tag colorKey="blue" /> · <Tag colorKey="blue" withDot shape="pill" />'}</CodeHint>
      </div>

      <Demo label="Kbd" code={'<Kbd>⌘</Kbd><Kbd>K</Kbd>'}>
        <span className="flex items-center gap-1">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd>
        </span>
      </Demo>
    </Section>
  )
}

// ── Section 6: Overlays ─────────────────────────────────────────────────────────

function OverlaysSection() {
  const [modal, setModal] = useState<null | 'md' | 'lg' | 'xl'>(null)
  const [slideOver, setSlideOver] = useState(false)
  const [popover, setPopover] = useState(false)
  const [menu, setMenu] = useState(false)

  return (
    <Section
      id="overlays"
      title="Overlays"
      note="Modal (Escape + backdrop + focus trap), SlideOver, Popover, and Menu all build on the overlay primitives. Never hand-roll fixed inset-0. Tooltip is pure CSS."
    >
      <Demo label="Modal" code={'<Modal size="md|lg|xl" footer={…} headerIcon={…} />'}>
        <Button variant="outline" onClick={() => setModal('md')}>
          Open md
        </Button>
        <Button variant="outline" onClick={() => setModal('lg')}>
          Open lg
        </Button>
        <Button variant="outline" onClick={() => setModal('xl')}>
          Open xl
        </Button>
      </Demo>

      <Demo label="SlideOver" code={'<SlideOver title="…" onClose={…} />'}>
        <Button variant="outline" onClick={() => setSlideOver(true)}>
          Open slide-over
        </Button>
      </Demo>

      <Demo label="Popover" code={'<Popover open={…} onClose={…} trigger={…} />'}>
        <Popover
          open={popover}
          onClose={() => setPopover(false)}
          align="start"
          trigger={
            <Button variant="outline" onClick={() => setPopover((v) => !v)}>
              Toggle popover
            </Button>
          }
        >
          <div className="p-3 text-sm text-text-dim">
            Any positioned panel — filters, colour pickers, date pickers — builds on Popover.
          </div>
        </Popover>
      </Demo>

      <Demo label="Menu" code={'<Menu trigger={…}> <MenuItem danger /> </Menu>'}>
        <Menu
          open={menu}
          onClose={() => setMenu(false)}
          align="start"
          trigger={
            <Button variant="outline" iconRight={<ChevronDownIcon />} onClick={() => setMenu((v) => !v)}>
              Actions
            </Button>
          }
        >
          <MenuLabel>Manage</MenuLabel>
          <MenuItem icon={<PencilIcon />} onClick={() => setMenu(false)}>
            Rename
          </MenuItem>
          <MenuItem icon={<CopyIcon />} trailing={<Kbd>⌘C</Kbd>} onClick={() => setMenu(false)}>
            Duplicate
          </MenuItem>
          <MenuItem icon={<ExternalLinkIcon />} disabled>
            Open in new tab
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<TrashIcon />} danger onClick={() => setMenu(false)}>
            Delete
          </MenuItem>
        </Menu>
      </Demo>

      <Demo label="Tooltip" code={'<Tooltip label="…" side="top|bottom">'}>
        <Tooltip label="Tooltip above" side="top">
          <Button variant="outline">Hover me (top)</Button>
        </Tooltip>
        <Tooltip label="Tooltip below" side="bottom">
          <Button variant="outline">Hover me (bottom)</Button>
        </Tooltip>
      </Demo>

      {modal && (
        <Modal
          title={`Modal — size ${modal}`}
          size={modal}
          headerIcon={modal === 'xl' ? <SparkleIcon className="text-accent" /> : undefined}
          onClose={() => setModal(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button onClick={() => setModal(null)}>Confirm</Button>
            </>
          }
        >
          <p className="text-sm text-text-dim">
            Escape, backdrop click, and the close button all dismiss. Focus is trapped inside the card and restored on
            close. This body scrolls if it overflows.
          </p>
          <div className="mt-4">
            <Field label="Example field">
              <Input placeholder="Type here…" />
            </Field>
          </div>
          <ModalFooter>
            <Badge tone="neutral">ModalFooter also available inside the body</Badge>
          </ModalFooter>
        </Modal>
      )}

      {slideOver && (
        <SlideOver
          title="Slide-over"
          subtitle="Notification-center pattern"
          icon={<BellIcon className="text-accent" />}
          onClose={() => setSlideOver(false)}
          footer={
            <Button variant="outline" onClick={() => setSlideOver(false)}>
              Close
            </Button>
          }
        >
          <div className="flex flex-col gap-2 p-4">
            {[1, 2, 3].map((i) => (
              <ListRow key={i} leading={<BellIcon className="text-text-faint" />} trailing={<CountBadge count={i} />}>
                Notification {i}
              </ListRow>
            ))}
          </div>
        </SlideOver>
      )}
    </Section>
  )
}

// ── Section 7: Surfaces ──────────────────────────────────────────────────────────

const BANNER_TONES = ['neutral', 'accent', 'warning', 'danger'] as const

function SurfacesSection() {
  const [tab, setTab] = useState('overview')
  const [choice, setChoice] = useState('a')
  const [choice2, setChoice2] = useState('x')
  const [row, setRow] = useState('two')

  return (
    <Section
      id="surfaces"
      title="Surfaces"
      note="Card is the panel recipe. PanelHeader, Banner, Divider, Tabs, ChoiceCard, and ListRow compose the structural chrome."
    >
      <Demo label="Card — padding + interactive" code={'<Card padding="sm|md|lg|none" interactive />'}>
        <Card padding="sm" className="w-32 text-2xs text-text-dim">
          padding sm
        </Card>
        <Card padding="md" className="w-32 text-2xs text-text-dim">
          padding md
        </Card>
        <Card padding="lg" className="w-32 text-2xs text-text-dim">
          padding lg
        </Card>
        <Card as="button" interactive padding="md" className="w-40 text-2xs text-text-dim">
          interactive (hover me)
        </Card>
      </Demo>

      <div>
        <SectionLabel className="mb-3">PanelHeader</SectionLabel>
        <div className="overflow-hidden rounded-xl border border-border bg-panel">
          <PanelHeader
            title="Channel details"
            subtitle="12 members"
            icon={<HashIcon className="text-text-faint" />}
            actions={
              <IconButton label="More" size="sm">
                <DotsIcon />
              </IconButton>
            }
            onClose={() => {}}
          />
        </div>
        <CodeHint>{'<PanelHeader title subtitle icon actions onClose />'}</CodeHint>
      </div>

      <div>
        <SectionLabel className="mb-3">Banner — all tones</SectionLabel>
        <div className="flex flex-col gap-2">
          {BANNER_TONES.map((t) => (
            <Banner
              key={t}
              tone={t}
              icon={<InfoIcon />}
              actions={
                <Button variant="ghost" size="xs">
                  Action
                </Button>
              }
            >
              {t} banner — an inline status notice.
            </Banner>
          ))}
        </div>
        <CodeHint>{'<Banner tone="warning" icon={…} actions={…} />'}</CodeHint>
      </div>

      <Demo label="Divider" code={'<Divider /> · <Divider label="Today" />'}>
        <div className="w-full max-w-md space-y-4">
          <Divider />
          <Divider label="Today" />
        </div>
      </Demo>

      <div>
        <SectionLabel className="mb-3">Tabs</SectionLabel>
        <Tabs
          active={tab}
          onChange={setTab}
          items={[
            { key: 'overview', label: 'Overview' },
            { key: 'members', label: 'Members', badge: <CountBadge count={12} muted /> },
            { key: 'settings', label: 'Settings' },
          ]}
        />
        <p className="mt-3 text-sm text-text-dim">Active tab: {tab}</p>
        <CodeHint>{'<Tabs items={[{key,label,badge}]} active onChange />'}</CodeHint>
      </div>

      <div>
        <SectionLabel className="mb-3">ChoiceCard — ring vs fill</SectionLabel>
        <div className="grid max-w-xl grid-cols-2 gap-3" role="radiogroup">
          <ChoiceCard
            selected={choice === 'a'}
            onSelect={() => setChoice('a')}
            title="Ring style"
            description="Selected shows an accent ring"
            selectedStyle="ring"
          >
            <div className="h-10 rounded-lg bg-panel-2" />
          </ChoiceCard>
          <ChoiceCard
            selected={choice === 'b'}
            onSelect={() => setChoice('b')}
            title="Ring style"
            description="Unselected sibling"
            selectedStyle="ring"
          >
            <div className="h-10 rounded-lg bg-panel-2" />
          </ChoiceCard>
        </div>
        <div className="mt-3 grid max-w-xl grid-cols-2 gap-3" role="radiogroup">
          <ChoiceCard
            selected={choice2 === 'x'}
            onSelect={() => setChoice2('x')}
            title="Fill style"
            description="Selected fills accent-soft"
            selectedStyle="fill"
          />
          <ChoiceCard
            selected={choice2 === 'y'}
            onSelect={() => setChoice2('y')}
            title="Fill style"
            description="Unselected sibling"
            selectedStyle="fill"
          />
        </div>
        <CodeHint>{'<ChoiceCard selected onSelect title selectedStyle="ring|fill" />'}</CodeHint>
      </div>

      <div>
        <SectionLabel className="mb-3">ListRow — sizes, selected, leading/trailing</SectionLabel>
        <div className="max-w-md rounded-xl border border-border bg-panel p-1">
          <ListRow
            size="sm"
            selected={row === 'one'}
            onClick={() => setRow('one')}
            leading={<span className="h-2 w-2 rounded-full bg-success-fg" />}
          >
            Small row · online
          </ListRow>
          <ListRow
            size="md"
            selected={row === 'two'}
            onClick={() => setRow('two')}
            leading={<span className="h-2 w-2 rounded-full bg-text-faint" />}
            trailing={<CountBadge count={4} />}
          >
            Medium row · selected + count
          </ListRow>
          <ListRow
            size="lg"
            selected={row === 'three'}
            onClick={() => setRow('three')}
            leading={<HashIcon className="text-text-faint" />}
            trailing={<ChevronRightIcon className="text-text-faint" />}
          >
            Large row · leading icon
          </ListRow>
        </div>
        <CodeHint>{'<ListRow size="md" selected leading={…} trailing={…} />'}</CodeHint>
      </div>
    </Section>
  )
}

// ── Section 8: Feedback ──────────────────────────────────────────────────────────

function FeedbackSection() {
  return (
    <Section
      id="feedback"
      title="Feedback"
      note="Spinner, Skeleton, EmptyState, and toasts. Every animation honours prefers-reduced-motion via the primitive."
    >
      <Demo label="Spinner — sizes" code={'<Spinner size="sm|md|lg" />'}>
        <Spinner size="sm" />
        <Spinner size="md" />
        <Spinner size="lg" />
      </Demo>

      <div>
        <SectionLabel className="mb-3">Skeleton</SectionLabel>
        <div className="flex max-w-md flex-col gap-2">
          <Skeleton className="h-8 w-1/2 rounded-lg" />
          <Skeleton className="h-4 rounded" />
          <Skeleton className="h-4 w-5/6 rounded" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-4 w-40 rounded" />
          </div>
        </div>
        <CodeHint>{'<Skeleton className="h-4 w-1/2 rounded" />'}</CodeHint>
      </div>

      <div>
        <SectionLabel className="mb-3">EditorSkeleton</SectionLabel>
        <div className="rounded-xl border border-border bg-panel">
          <EditorSkeleton />
        </div>
        <CodeHint>{'<EditorSkeleton />'}</CodeHint>
      </div>

      <div>
        <SectionLabel className="mb-3">EmptyState — 3 variants</SectionLabel>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-panel">
            <EmptyState
              variant="centered"
              icon={<SearchIcon />}
              title="No results"
              description="Try a different search term."
              action={<Button size="sm">Clear search</Button>}
            />
          </div>
          <EmptyState
            variant="dashed"
            icon={<PlusIcon />}
            title="No projects yet"
            description="Create your first project to get started."
            action={
              <Button size="sm" iconLeft={<PlusIcon />}>
                New project
              </Button>
            }
          />
          <div className="rounded-xl border border-border bg-panel p-2">
            <EmptyState variant="inline" title="Nothing here yet." />
          </div>
        </div>
        <CodeHint>{'<EmptyState variant="centered|dashed|inline" icon title description action />'}</CodeHint>
      </div>

      <Demo label="Toasts" code={'toastSuccess("…") · toastInfo("…") · toastError("…")'}>
        <Button variant="outline" onClick={() => toastSuccess('Saved successfully')}>
          toastSuccess
        </Button>
        <Button variant="outline" onClick={() => toastInfo('Heads up — this is info')}>
          toastInfo
        </Button>
        <Button variant="outline" onClick={() => toastError('Something went wrong')}>
          toastError
        </Button>
      </Demo>
    </Section>
  )
}

// ── Section 9: Icons ──────────────────────────────────────────────────────────────

const ICONS: { name: string; Comp: ComponentType<IconProps> }[] = [
  { name: 'CloseIcon', Comp: CloseIcon },
  { name: 'ChevronDownIcon', Comp: ChevronDownIcon },
  { name: 'ChevronRightIcon', Comp: ChevronRightIcon },
  { name: 'ChevronLeftIcon', Comp: ChevronLeftIcon },
  { name: 'ChevronUpIcon', Comp: ChevronUpIcon },
  { name: 'PlusIcon', Comp: PlusIcon },
  { name: 'SearchIcon', Comp: SearchIcon },
  { name: 'CheckIcon', Comp: CheckIcon },
  { name: 'TrashIcon', Comp: TrashIcon },
  { name: 'PencilIcon', Comp: PencilIcon },
  { name: 'CopyIcon', Comp: CopyIcon },
  { name: 'ExternalLinkIcon', Comp: ExternalLinkIcon },
  { name: 'ArrowRightIcon', Comp: ArrowRightIcon },
  { name: 'BellIcon', Comp: BellIcon },
  { name: 'UserIcon', Comp: UserIcon },
  { name: 'HashIcon', Comp: HashIcon },
  { name: 'CalendarIcon', Comp: CalendarIcon },
  { name: 'ClockIcon', Comp: ClockIcon },
  { name: 'WarningIcon', Comp: WarningIcon },
  { name: 'InfoIcon', Comp: InfoIcon },
  { name: 'SparkleIcon', Comp: SparkleIcon },
  { name: 'DotsIcon', Comp: DotsIcon },
  { name: 'SendIcon', Comp: SendIcon },
  { name: 'GearIcon', Comp: GearIcon as ComponentType<IconProps> },
  { name: 'LockIcon', Comp: LockIcon as ComponentType<IconProps> },
  { name: 'EyeIcon', Comp: EyeIcon as ComponentType<IconProps> },
  { name: 'EyeOffIcon', Comp: EyeOffIcon as ComponentType<IconProps> },
]

function IconsSection() {
  return (
    <Section
      id="icons"
      title="Icons"
      note={
        <>
          Every glyph exported from <code className="font-mono text-xs">ui/icons.tsx</code>. 24-unit viewBox,{' '}
          <code className="font-mono text-xs">currentColor</code> stroke, stroke-width 2. Add missing glyphs here — never
          hand-roll a local icon.
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {ICONS.map(({ name, Comp }) => (
          <div
            key={name}
            className="flex flex-col items-center gap-2 rounded-lg border border-border bg-panel-2 px-2 py-4 text-center"
          >
            <Comp size={22} className="text-text" />
            <span className="font-mono text-3xs text-text-faint">{name}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

// ── Section 10: Motion & rules ──────────────────────────────────────────────────

const Z_BANDS: [string, string][] = [
  ['--z-dropdown', '30 · menus / popovers'],
  ['--z-slideover', '40 · slide-overs'],
  ['--z-modal', '50 · dialogs'],
  ['--z-overlay', '60 · palettes, notification center'],
  ['--z-floating', '70 · in-call widgets'],
  ['--z-popover', '80 · user cards'],
  ['--z-toast', '100 · toasts'],
  ['--z-lightbox', '110 · lightbox'],
]

const RADIUS_RULES: [string, string][] = [
  ['rounded-md', 'controls: buttons, menu items'],
  ['rounded-lg', 'inputs, menus, small cards'],
  ['rounded-xl', 'cards, dialogs, panels'],
  ['rounded-2xl', 'sheets / hero cards'],
  ['rounded-full', 'pills, badges, toggles'],
]

function MotionSection() {
  return (
    <Section
      id="motion"
      title="Motion & rules"
      note="The structural invariants: z-index bands, radius scale, the focus ring, and the reduced-motion contract."
    >
      <div>
        <SectionLabel className="mb-3">Z-index bands</SectionLabel>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[24rem] text-left text-sm">
            <tbody>
              {Z_BANDS.map(([v, role]) => (
                <tr key={v} className="border-b border-border-soft last:border-0">
                  <td className="py-1.5 pr-6 font-mono text-2xs text-text">{v}</td>
                  <td className="py-1.5 text-text-dim">{role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <CodeHint>Use z-(--z-*) bands — never invent z-[NN] values.</CodeHint>
      </div>

      <div>
        <SectionLabel className="mb-3">Radius rules</SectionLabel>
        <div className="flex flex-wrap gap-4">
          {RADIUS_RULES.map(([cls, role]) => (
            <div key={cls} className="flex flex-col items-center gap-2">
              <div className={cn('h-14 w-14 border border-border bg-panel-2', cls)} />
              <span className="font-mono text-3xs text-text">{cls}</span>
              <span className="max-w-28 text-center text-3xs text-text-faint">{role}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel className="mb-3">Focus ring</SectionLabel>
        <p className="mb-3 max-w-xl text-sm text-text-dim">
          Every interactive element shows <code className="font-mono text-xs">focus-visible:ring-2 ring-accent</code>.
          Tab to these to see it (primitives bake it in):
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline">Tab to me</Button>
          <IconButton label="Focus demo">
            <BellIcon />
          </IconButton>
          <Input placeholder="…and me" className="w-40" />
        </div>
      </div>

      <div>
        <SectionLabel className="mb-3">Reduced motion</SectionLabel>
        <p className="max-w-xl text-sm text-text-dim">
          Motion tokens: <code className="font-mono text-xs">--motion-snap</code> (160ms) for hover/press,{' '}
          <code className="font-mono text-xs">--motion-smooth</code> (220ms) for movement. Every looping / entrance
          animation must honour <code className="font-mono text-xs">prefers-reduced-motion</code> (e.g.{' '}
          <code className="font-mono text-xs">motion-reduce:animate-none</code>) — the Spinner and press-scale already
          do.
        </p>
      </div>
    </Section>
  )
}

// ── Nav + page shell ─────────────────────────────────────────────────────────────

const NAV: { id: string; label: string }[] = [
  { id: 'tokens', label: 'Tokens' },
  { id: 'typography', label: 'Typography' },
  { id: 'buttons', label: 'Buttons' },
  { id: 'form', label: 'Form' },
  { id: 'badges', label: 'Badges & chips' },
  { id: 'overlays', label: 'Overlays' },
  { id: 'surfaces', label: 'Surfaces' },
  { id: 'feedback', label: 'Feedback' },
  { id: 'icons', label: 'Icons' },
  { id: 'motion', label: 'Motion & rules' },
]

export function DesignGallery() {
  return (
    <div className="min-h-screen overflow-y-auto bg-ink text-text">
      {/* Sticky top nav — anchor links per section */}
      <header className="sticky top-0 z-(--z-dropdown) border-b border-border bg-ink/85 backdrop-blur-md">
        <div className="mx-auto max-w-5xl px-4 py-3">
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-semibold text-text">sharp Design System</span>
            <Badge tone="accent" uppercase>
              /design
            </Badge>
          </div>
          <nav className="mt-2 flex flex-wrap gap-1.5">
            {NAV.map((n) => (
              <a
                key={n.id}
                href={`#${n.id}`}
                className="rounded-md px-2 py-1 text-2xs font-medium text-text-dim transition-colors hover:bg-panel-2 hover:text-text"
              >
                {n.label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-14 px-4 py-10">
        <div>
          <Heading level={1}>Design System</Heading>
          <p className="mt-2 max-w-2xl text-sm text-text-dim">
            The living catalog of every primitive in <code className="font-mono text-xs">web/src/ui/</code>. Companion to{' '}
            <code className="font-mono text-xs">docs/DESIGN_SYSTEM.md</code>. When you add a variant, add it here too.
          </p>
        </div>

        <TokensSection />
        <TypographySection />
        <ButtonsSection />
        <FormSection />
        <BadgesSection />
        <OverlaysSection />
        <SurfacesSection />
        <FeedbackSection />
        <IconsSection />
        <MotionSection />

        <footer className="pb-10 pt-4 text-center text-2xs text-text-faint">
          Every primitive imported from the <code className="font-mono">ui</code> barrel · dev-only route
        </footer>
      </main>
    </div>
  )
}
