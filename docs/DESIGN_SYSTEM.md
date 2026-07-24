# sharp Design System

Single source of truth for UI construction in `web/`. **Agents and humans: read this before writing any JSX with visual styling.** The live component catalog is at `/design` (dev builds only — `bun run dev`, then http://localhost:5173/design).

## The one rule

**Never hand-roll a pattern that exists in `web/src/ui/`.** Import from the barrel:

```tsx
import { Button, Input, Field, Modal, Menu, MenuItem, Badge, EmptyState } from '../ui'
```

If a variant you need is missing, extend the primitive in `web/src/ui/` (new variant/prop) — do not fork a local copy or inline the class recipe. That is how divergence happened the first time.

## Tokens

All colors are CSS variables defined in `web/src/index.css` `@theme`, themeable via `:root[data-theme=...]` presets (default purple, `slack`, `teams`, `one-piece`). **Never hard-code hex in components** — it breaks the theme presets. Tailwind v4 generates utilities from `@theme`, so prefer the short form:

| Token | Utility | Role |
|---|---|---|
| `--color-ink` | `bg-ink` | app background |
| `--color-panel` | `bg-panel` | surfaces: cards, modals, menus |
| `--color-panel-2` | `bg-panel-2` | input fill, hover fill |
| `--color-border` / `--color-border-soft` | `border-border` | hairlines |
| `--color-accent` / `-hover` / `-soft` | `bg-accent`, `bg-accent-soft` | brand; `-soft` = selected-row bg |
| `--color-text` / `-dim` / `-faint` | `text-text-dim` etc. | 3-step text hierarchy |
| `--color-danger` / `-hover` / `-soft` / `-fg` | `bg-danger`, `text-danger-fg` | destructive |
| `--color-success` / `-soft` / `-fg` | `text-success-fg` | positive |
| `--color-warning` / `-soft` / `-fg` | `text-warning-fg` | caution |

Legacy long form `bg-[var(--color-panel)]` is equivalent; use short form in new code.

### Type scale

`text-3xs` (10px, micro/badges) → `text-2xs` (11px, captions/metadata) → `text-xs` (dense body) → `text-sm` (**default body & controls**) → `text-base` → `text-lg` (panel headings) → `text-xl`/`text-2xl` (page titles) → `text-3xl sm:text-4xl` (hero). Emphasis weight is `font-semibold`; `font-medium` for soft emphasis. Never use raw `text-[10px]`/`text-[11px]` — use `text-3xs`/`text-2xs`.

### Radius rules

- Controls (buttons, menu items): `rounded-md`
- Inputs, menus, small cards: `rounded-lg`
- Cards, dialogs, panels: `rounded-xl`
- Sheets / hero cards: `rounded-2xl`
- Pills, badges, toggles: `rounded-full`

### Z-index bands (vars in `:root`, use `z-(--z-*)`)

`--z-dropdown:30` menus/popovers · `--z-slideover:40` · `--z-modal:50` · `--z-overlay:60` palettes, notification center · `--z-floating:70` in-call widgets · `--z-popover:80` user cards · `--z-toast:100` · `--z-lightbox:110`. Never invent `z-[NN]` values.

### Motion

`--motion-snap` (160ms) for hover/press, `--motion-smooth` (220ms) + `--motion-spring` easing for movement. Every looping/entrance animation must honor `prefers-reduced-motion` (`motion-reduce:animate-none` or a media block). Signature micro-interactions live in the primitives (button press-scale, `.micro-icon-button` spring) — you get them for free by using the primitives.

### Focus

Every interactive element shows `focus-visible:ring-2 focus-visible:ring-accent` (with `outline-none`). Primitives bake this in; if you write a raw `<button>` (rare), add it.

## Components — `web/src/ui/`

Atoms:

| Component | Props (defaults first) | Replaces |
|---|---|---|
| `Button` | `variant: 'primary'\|'outline'\|'ghost'\|'danger'`, `size: 'md'\|'xs'\|'sm'\|'lg'`, `pill`, `block`, `loading`, `iconLeft/iconRight`, native button props | every inline button recipe |
| `IconButton` | `label` (required, aria-label), `size: 'md'(h-9)\|'sm'(h-8)\|'lg'(h-10)\|'xl'(h-11)`, `variant: 'ghost'\|'accent'\|'danger'`, `shape: 'square'\|'circle'`, `micro` (spring hover) | icon-only buttons, close X |
| `Input` / `Textarea` / `Select` | `uiSize: 'md'\|'sm'\|'lg'`, `surface: 'panel-2'\|'panel'`, `invalid`, `prefix` (Input: icon/`#` inside focus-within group) | the 34× field recipe |
| `SearchInput` | `variant: 'boxed'\|'palette'` (palette = borderless underline for command palettes) | palette + boxed search |
| `Field` | `label`, `hint`, `error`, `required`, wraps one control | label/hint/error rows |
| `SectionLabel` | `tone: 'faint'\|'accent'`, `size: 'xs'\|'2xs'\|'3xs'`, `as` | uppercase kickers + sidebar section labels |
| `Heading` | `level: 1\|2\|3` (1=page, 2=panel `text-lg`, 3=modal `text-sm font-semibold`) | ad-hoc headings |
| `Badge` | `tone: 'neutral'\|'accent'\|'success'\|'warning'\|'danger'`, `variant: 'soft'\|'solid'\|'outline'`, `uppercase` | status/BETA/guest pills |
| `CountBadge` | `count`, `max=99` (renders `99+`), `muted` | 6 unread-badge variants |
| `Tag` | `colorKey` (boardColors key), `withDot`, `shape: 'square'\|'pill'` | board/task colored chips |
| `Kbd` | children | shortcut chips |
| `Spinner` | `size: 'md'\|'sm'\|'lg'` — always `motion-reduce:animate-none` | 4 divergent spinners |
| `Skeleton` | `className` (sizing); `EditorSkeleton` preset | `.skeleton` divs |
| `Divider` | `label?` (centered pill like DayDivider) | `h-px bg-border` rows |
| `Tooltip` | `label`, `side: 'top'\|'bottom'`, wraps trigger; generic `[data-tooltip]` CSS | dock-only tooltip; styled replacement for `title=` |

Composites:

| Component | Props | Notes |
|---|---|---|
| `Modal` | `title`, `onClose`, `size: 'md'\|'lg'\|'xl'`, `footer?`, `headerIcon?`, `children` (legacy `wide` still works) | Escape + backdrop + focus trap + open/close sound built in. **Never hand-roll `fixed inset-0` dialogs.** |
| `ModalFooter` | children | `flex justify-end gap-2 pt-4` action row |
| `SlideOver` | `side:'right'`, `width`, `title`, `onClose`, `portal?`, `footer?` | notification center / card panel pattern; Escape built in |
| `Popover` | `open`, `onClose`, `align:'start'\|'end'`, `side:'bottom'\|'top'`, `width` — positioned panel + dismiss | all dropdown panels |
| `useDismiss` | `{ref, onClose, escape=true, outside=true}` | THE click-outside/Escape hook; never re-implement |
| `Menu` / `MenuItem` | Menu wraps Popover with `role="menu"`; MenuItem: `icon?`, `danger`, `disabled` | the 3 duplicate MenuItem defs |
| `Card` | `interactive` (hover border-accent + focus ring), `padding: 'md'\|'sm'\|'lg'\|'none'`, `as` | panel surface recipe |
| `PanelHeader` | `title`, `subtitle?`, `icon?`, `actions?`, `onClose?` | h-14 border-b header + close X |
| `EmptyState` | `icon?`, `title`, `description?`, `action?`, `variant: 'centered'\|'dashed'\|'inline'` | 6 local EmptyState copies |
| `Banner` | `tone: 'neutral'\|'accent'\|'warning'\|'danger'`, `actions?` | trash/call/poll banners |
| `Tabs` | `items: {key,label,badge?}[]`, `active`, `onChange` | underline tabs (ChannelTabs) |
| `ChoiceCard` | `selected`, `onSelect`, `title`, `description?`, `selectedStyle: 'ring'\|'fill'`, children = preview | ThemeCard / LayoutCard / VisibilityOption |
| `ListRow` | `as: 'button'\|'a'\|'div'`, `size: 'md'\|'sm'\|'lg'`, `selected`, `leading?`, `trailing?` | sidebar/palette/notification rows |
| `Toggle` / `ToggleVisual` | unchanged | already canonical |

`Toasts` (`lib/toast.ts`) and `Avatar` stay where they are — they are already centralized; `ui/index.ts` re-exports them for convenience.

## Layout & wireframe rules

- **Shell**: mode rail + collapsible `sidebar-shell` (16rem / 4.5rem) + main column. Mobile (`max-width: 800px`): rail/sidebar omitted, `MobileTabBar` bottom bar, `.mobile-sheet` for sheets. Respect `--safe-*` / `--titlebar-h` vars on any fixed-position chrome (`.safe-pad*` helpers).
- **Panels**: right-hand contextual panels are 420px inline columns on desktop (`SlideOver` inline mode), overlay sheets on mobile.
- **Tap targets**: interactive rows/buttons on touch surfaces get `min-h-11`.
- **Spacing rhythm**: 4px grid; content padding `p-4` (panels) / `px-3 py-2` (rows); section gaps `gap-5` in forms, `gap-2` between related controls.
- **Text hierarchy per surface**: title (`Heading`) → metadata (`text-2xs text-text-faint`) → body (`text-sm`). One accent element per region.

## Anti-patterns (reject in review)

- Inline `className` button/input recipes → use `Button`/`Input`.
- `fixed inset-0` outside `ui/` overlay primitives.
- New `window.addEventListener('keydown'/'mousedown')` dismiss logic → `useDismiss`.
- Hard-coded hex colors (incl. `text-red-400`, `bg-red-600`, `#ff8a80`) → tone tokens.
- `text-[10px]`/`text-[11px]` → `text-3xs`/`text-2xs`.
- `z-[NN]` arbitrary values → `z-(--z-*)` bands.
- Local `function XIcon()` for a glyph that exists in `web/src/ui/icons.tsx` — check the registry first, add there if missing (defaults: 24 viewBox, `stroke-width 2`, `currentColor`, `aria-hidden`).
- Animations without a reduced-motion fallback.

## Extending

1. Add the variant/prop to the primitive in `web/src/ui/` (keep the variant maps flat — plain objects of class strings, no CVA dep).
2. Add a row to the `/design` gallery (`web/src/ui/DesignGallery.tsx`) showing the new variant.
3. Update the table in this file.

All three steps in the same change — the gallery and this doc must never lag the code.
