# sharp Design System

Single source of truth for UI construction in `web/`. **Agents and humans: read this before writing any JSX with visual styling.** The live component catalog is at `/design` (dev builds only — `bun run dev`, then http://localhost:5173/design).

## The one rule

**Never hand-roll a pattern that exists in `web/src/ui/`.** Import from the barrel:

```tsx
import { Button, Input, Field, Modal, Menu, MenuItem, Badge, EmptyState } from '../ui'
```

If a variant you need is missing, extend the primitive in `web/src/ui/` (new variant/prop) — do not fork a local copy or inline the class recipe. That is how divergence happened the first time.

## Tokens

All colors are CSS variables defined in `web/src/index.css` `@theme`, themeable via `:root[data-theme=...]` presets in `web/src/themes.css`. **Never hard-code hex in components** — it breaks the theme presets. Tailwind v4 generates utilities from `@theme`, so prefer the short form:

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
| `--color-share` / `-soft` / `-fg` | `bg-share`, `text-share-fg` | "live out" — you are broadcasting (screen share) |
| `--color-code-bg` / `-code-block-bg` | `bg-code-bg` | inline code / code block fill |
| `--color-scrollbar` / `-hover` | — | custom scrollbar thumb |
| `--color-kbd-edge` | `border-b-kbd-edge` | `Kbd` bottom bevel |
| `--color-presence-online` / `-offline` | — | presence dots |

The last four rows are `color-mix()` derivations of the core eleven, so they retint with every preset — that is the whole reason they exist. Do not replace them with hex.

Legacy long form `bg-[var(--color-panel)]` is equivalent; use short form in new code.

### Themes

A preset is one `:root[data-theme='<id>']` block in `web/src/themes.css` declaring only the **core eleven** — `ink`, `panel`, `panel-2`, `border`, `border-soft`, `accent`, `accent-hover`, `accent-soft`, `text`, `text-dim`, `text-faint`. Semantic tones and the board palette are scheme-wide (dark set in `@theme`, one `:root[data-scheme='light']` override), and the derived chrome above comes free.

Fifteen ship today: `default`, `daylight`, `nord`, `dracula`, `catppuccin-mocha`, `catppuccin-latte`, `tokyo-night`, `gruvbox`, `solarized-light`, `paper`, `high-contrast`, `terminal`, `slack`, `teams`, `one-piece`. Light presets also declare `color-scheme: light`.

**Adding one:** the CSS block + an entry in `THEMES` (`web/src/lib/theme.ts`, with `scheme` and an optional `pairWith` sibling for System mode). Then open `/design` — the token audit walks every preset and names anything that fails to resolve.

### Density & scale

User-controlled, so never hard-code a row height or avatar size on a chat surface:

| Token | Use |
|---|---|
| `--density-msg-y` | leading padding of a message that starts a group |
| `--density-row-y` | padding of a message collapsed into the group above |
| `--density-gap` | gap between related rows |
| `--density-avatar` | avatar box (`w-(--density-avatar)`); the px number is `AVATAR_PX[density]` in `lib/theme.ts` for JS call sites |

`--font-scale` scales the root font size, so everything sized in rem grows together — that is the interface-scale control, and it is why arbitrary px sizing is a bug.

### Type scale

`text-3xs` (10px, micro/badges) → `text-2xs` (11px, captions/metadata) → `text-xs` (dense body) → `text-sm` (**default body & controls**) → `text-base` → `text-lg` (panel headings) → `text-xl`/`text-2xl` (page titles) → `text-3xl sm:text-4xl` (hero). Emphasis weight is `font-semibold`; `font-medium` for soft emphasis. Never use raw `text-[10px]`/`text-[11px]` — use `text-3xs`/`text-2xs`.

### Radius rules

- Controls (buttons, menu items): `rounded-md`
- Inputs, menus, small cards: `rounded-lg`
- Cards, dialogs, panels: `rounded-xl`
- Sheets / hero cards: `rounded-2xl`
- Pills, badges, toggles: `rounded-full`

### Z-index bands (vars in `:root`, use `z-(--z-*)`)

`--z-dropdown:30` in-flow dropdowns · `--z-slideover:40` · `--z-modal:50` · `--z-overlay:60` palettes, notification center · `--z-floating:70` in-call widgets · `--z-popover:80` `Popover`/`Menu` panels + user cards · `--z-toast:100` · `--z-lightbox:110`. Never invent `z-[NN]` values. `Popover` sits at `--z-popover` because it portals to `document.body` — it must clear the modal it may be opened from.

### Motion

`--motion-snap` (160ms) for hover/press, `--motion-smooth` (220ms) + `--motion-spring` easing for movement. Both are `calc()`-multiplied by `--motion-scale`, the user's motion slider (0 = still) — so use the tokens, never a literal duration, or the slider will not reach your animation. Every looping/entrance animation must honor `prefers-reduced-motion` (`motion-reduce:animate-none` or a media block). Signature micro-interactions live in the primitives (button press-scale, `.micro-icon-button` spring) — you get them for free by using the primitives.

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
| `Modal` | `title`, `onClose`, `size: 'md'\|'lg'\|'xl'`, `footer?`, `headerIcon?`, `children` (legacy `wide` still works) | Escape + backdrop + focus trap + open/close sound built in; portals into `document.body`, so it stays full-viewport even when opened from a transformed/contained ancestor (e.g. a chat row). **Never hand-roll `fixed inset-0` dialogs.** |
| `ModalFooter` | children | `flex justify-end gap-2 pt-4` action row |
| `SlideOver` | `side:'right'`, `width`, `title`, `onClose`, `portal?`, `footer?` | notification center / card panel pattern; Escape built in |
| `Sheet` | `title`, `subtitle?`, `onClose`, `footer?`, `initialFocusRef?` | bottom sheet for picking one thing on touch (section, mode, filter). Grabber + Escape + backdrop + focus trap + safe-area padding; rises with `.sharp-sheet` (`--motion-smooth`, reduced-motion aware). **Use it instead of a native `<select>` on mobile chrome** — the OS listbox ignores the theme and covers the page — and instead of `Menu` when the trigger sits at the top of a small screen. Not to be confused with `.mobile-sheet` (index.css), the full-height mobile panel for threads/Sharpy. |
| `Popover` | `open`, `onClose`, `align:'start'\|'center'\|'end'`, `side:'bottom'\|'top'`, `width`, `matchTriggerWidth`, `anchorClassName` (trigger wrapper — pass `relative flex` for a trigger in a flex row), `role`, `aria-label` — panel portaled to `body`, `fixed` off the trigger rect, flips side + clamps to the viewport, re-measures on scroll/resize/content change. Escapes ancestor `overflow` (modal bodies, scrolling lists) and stacking contexts. Caps its own height unless you pass a `max-h-*` in `className`; `matchTriggerWidth` for trigger-width panels (`w-full` no longer works — the panel is not a child of the trigger) | all dropdown panels |
| `useDismiss` | `{ref, onClose, escape=true, outside=true}` — `ref` also takes an array (a portaled panel plus its trigger); Escape only fires on the topmost registered layer, so a picker inside a modal closes the picker alone | THE click-outside/Escape hook; never re-implement |
| `useFocusTrap` | `{ref, initialFocusRef?}` | focus in on open, Tab loop at the edges, focus restored on close — shared by `Modal` and `Sheet`; never hand-roll a Tab loop |
| `Menu` / `MenuItem` | Menu wraps Popover with `role="menu"`; MenuItem: `icon?`, `danger`, `disabled`, `active` (keyboard-cursor highlight), `trailing?`, `onMouseEnter?` | the 3 duplicate MenuItem defs + filterable pickers |
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
- **Panels**: right-hand contextual panels are 420px inline columns on desktop (`SlideOver` inline mode), overlay sheets on mobile. The doc peek (`DocPeekPanel`, doc/canvas/board opened from a chat chip or the in-channel gallery) is *not* a side panel — it covers the main content column (`absolute inset-0` inside the outlet region, rail + channel sidebar stay visible) with a Back / "Open in …" header bar, and closes on Back or any route change (no Escape — embedded editors own that key).
- **Tap targets**: interactive rows/buttons on touch surfaces get `min-h-11`.
- **Spacing rhythm**: 4px grid; content padding `p-4` (panels) / `px-3 py-2` (rows); section gaps `gap-5` in forms, `gap-2` between related controls.
- **Text hierarchy per surface**: title (`Heading`) → metadata (`text-2xs text-text-faint`) → body (`text-sm`). One accent element per region.

## Keyboard

**Never attach `window.addEventListener('keydown')` for a feature shortcut.** Declare it in `SHORTCUTS` (`web/src/lib/shortcuts.ts`) and bind with `registerShortcut(id, handler)` — that is what makes it appear in the `?` cheat sheet, remappable, and subject to scope resolution (`overlay` > `pane` > `global`) and the editable-target guard. A raw listener is correct only for a key *family* one chord cannot express (the module chord over digits 1–9) or a purely contextual key (Escape unwinding whatever is open); both are commented as such where they exist.

Render a chord with `formatChord(chordFor(id))` inside `<Kbd>`, never a hard-coded "⌘K" — the user may have rebound it.

## Anti-patterns (reject in review)

- Inline `className` button/input recipes → use `Button`/`Input`.
- `fixed inset-0` outside `ui/` overlay primitives.
- New `window.addEventListener('keydown'/'mousedown')` dismiss logic → `useDismiss`.
- Hard-coded hex colors (incl. `text-red-400`, `bg-red-600`, `#ff8a80`) → tone tokens.
- `text-[10px]`/`text-[11px]` → `text-3xs`/`text-2xs`.
- `z-[NN]` arbitrary values (and bare `z-30`/`z-40`/`z-50`) → `z-(--z-*)` bands.
- A hand-rolled `absolute` dropdown panel next to its trigger → `Popover`/`Menu`. An absolute panel is clipped by the first scrolling ancestor and can't cross a stacking context; `Popover` portals and anchors for you.
- Local `function XIcon()` for a glyph that exists in `web/src/ui/icons.tsx` — check the registry first, add there if missing (defaults: 24 viewBox, `stroke-width 2`, `currentColor`, `aria-hidden`).
- Animations without a reduced-motion fallback.
- A new `window.addEventListener('keydown')` for a shortcut → `registerShortcut`.
- Hard-coded row padding or avatar size on a chat surface → the `--density-*` tokens.
- Literal durations in transitions → `--motion-snap` / `--motion-smooth`, so the motion slider reaches them.

## Extending

1. Add the variant/prop to the primitive in `web/src/ui/` (keep the variant maps flat — plain objects of class strings, no CVA dep).
2. Add a row to the `/design` gallery (`web/src/ui/DesignGallery.tsx`) showing the new variant.
3. Update the table in this file.

All three steps in the same change — the gallery and this doc must never lag the code.

## `TODO(ds)` comments are decisions, not debt

A `// TODO(ds):` or `{/* TODO(ds): */}` comment in `web/src/components/` marks a spot where a
primitive was deliberately **not** used, with the reason stated inline — a bespoke tone that has
no token, a pill that doubles as a drag handle, a panel on `bg-ink` instead of `bg-panel`, an
avatar that must render a `?` placeholder. They were audited when the design system landed.

Leave them alone unless you are adding the missing variant properly (all three steps above), in
which case delete the comment in the same change. Do not "clean them up" by forcing the
primitive in — that is how the exceptions became exceptions.
