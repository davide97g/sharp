// The app's keyboard layer.
//
// Before this, roughly fifteen components each attached their own
// `window.addEventListener('keydown')`. Nothing could enumerate the bindings, so
// there was no cheat sheet, no remapping, and no way to notice two features
// claiming the same key. This module is the single listener: features *declare*
// what they want, and the dispatcher decides who wins.
//
// Three rules make the dispatch predictable:
//   1. **Scopes.** A binding belongs to a scope. The innermost active scope with
//      a match handles the key, so a modal's Escape beats the global one.
//   2. **Editable targets.** Bindings without a modifier never fire while the
//      user is typing, unless they opt in with `allowInInput`.
//   3. **Remapping.** A user binding from `ui.shortcuts` shadows the default for
//      that action id; everything else — the cheat sheet, conflict detection —
//      reads through the same table, so nothing goes stale.

export type ShortcutScope = 'global' | 'pane' | 'overlay'

/** Parsed form of a chord string like `mod+k`, `shift+/`, `g c`. */
export type Chord = {
  key: string
  mod: boolean // ⌘ on macOS, Ctrl elsewhere
  shift: boolean
  alt: boolean
}

export type ShortcutDef = {
  /** Stable id — remapping and the cheat sheet key off this, never the chord. */
  id: string
  /** Human label for the cheat sheet. */
  label: string
  /** Cheat-sheet grouping. */
  group: string
  /** Default chord, in the string form parsed by `parseChord`. */
  defaultChord: string
  scope: ShortcutScope
  /** Fire even while a text field has focus (only sensible with a modifier). */
  allowInInput?: boolean
  /** Hidden from the cheat sheet (contextual keys like Escape). */
  hidden?: boolean
  /**
   * Documented in the cheat sheet but not dispatched here — for key *families*
   * (the module chord over digits 1–9) that one chord cannot express. Owned by
   * the feature, listed here so the cheat sheet stays complete.
   */
  displayOnly?: string
}

export const isMacPlatform =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const isTauriShell =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Browsers reserve ⌘/Ctrl+digit for tab switching, so the module-jump chord
 * adapts: the desktop shell has no browser chrome and can use the native
 * combination, Mac browsers fall back to ⌃, everything else to Alt.
 */
export const MODE_CHORD_PREFIX = isTauriShell
  ? isMacPlatform
    ? 'mod'
    : 'mod'
  : isMacPlatform
    ? 'ctrl'
    : 'alt'

export const MODE_CHORD_LABEL = isTauriShell
  ? isMacPlatform
    ? '⌘'
    : 'Ctrl+'
  : isMacPlatform
    ? '⌃'
    : 'Alt+'

// --- the registry ------------------------------------------------------------

export const SHORTCUTS: ShortcutDef[] = [
  {
    id: 'palette.open',
    label: 'Command palette',
    group: 'Navigation',
    defaultChord: 'mod+k',
    scope: 'global',
    allowInInput: true,
  },
  {
    id: 'search.open',
    label: 'Search messages',
    group: 'Navigation',
    defaultChord: 'mod+f',
    scope: 'global',
    allowInInput: true,
  },
  {
    id: 'sidebar.toggle',
    label: 'Show / hide sidebar',
    group: 'Navigation',
    defaultChord: '\\',
    scope: 'global',
  },
  {
    id: 'shortcuts.help',
    label: 'Keyboard shortcuts',
    group: 'Navigation',
    defaultChord: 'shift+?',
    scope: 'global',
  },
  {
    id: 'mode.jump',
    label: 'Jump to module 1–9',
    group: 'Navigation',
    defaultChord: '',
    scope: 'global',
    displayOnly: `${MODE_CHORD_LABEL}1 … ${MODE_CHORD_LABEL}9`,
  },
  {
    id: 'privacy.lock',
    label: 'Lock the screen',
    group: 'Privacy',
    defaultChord: 'mod+shift+l',
    scope: 'global',
    allowInInput: true,
  },
  {
    id: 'message.react',
    label: 'React to the hovered message',
    group: 'Messages',
    defaultChord: 'e',
    scope: 'pane',
  },
  {
    id: 'message.reply',
    label: 'Reply to the hovered message',
    group: 'Messages',
    defaultChord: 'r',
    scope: 'pane',
  },
  {
    id: 'message.thread',
    label: 'Open the hovered message in a thread',
    group: 'Messages',
    defaultChord: 't',
    scope: 'pane',
  },
  {
    id: 'message.next',
    label: 'Next message',
    group: 'Messages',
    defaultChord: 'j',
    scope: 'pane',
  },
  {
    id: 'message.prev',
    label: 'Previous message',
    group: 'Messages',
    defaultChord: 'k',
    scope: 'pane',
  },
  {
    id: 'call.mute',
    label: 'Mute / unmute your microphone',
    group: 'Call',
    defaultChord: 'm',
    scope: 'global',
  },
  {
    id: 'call.ptt',
    label: 'Push to talk (while the mode is on)',
    group: 'Call',
    defaultChord: '',
    scope: 'global',
    // A hold is a keydown/keyup pair, which no chord describes. VideoStage owns the
    // listener; this entry exists so the key is still documented and discoverable.
    displayOnly: 'Hold Space',
  },
  {
    id: 'garden.leave',
    label: 'Leave the garden',
    group: 'Garden',
    defaultChord: 'escape',
    scope: 'pane',
  },
  {
    id: 'garden.timer',
    label: 'Focus timer',
    group: 'Garden',
    defaultChord: 't',
    scope: 'pane',
  },
]

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]))

// --- chord parsing and formatting -------------------------------------------

export function parseChord(input: string): Chord {
  const parts = input.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  return {
    key,
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt') || parts.includes('ctrl'),
  }
}

/** The chord as a user reads it, platform-appropriate. */
export function formatChord(input: string): string {
  const parts = input.toLowerCase().split('+')
  const out: string[] = []
  for (const p of parts.slice(0, -1)) {
    if (p === 'mod') out.push(isMacPlatform ? '⌘' : 'Ctrl')
    else if (p === 'shift') out.push('⇧')
    else if (p === 'alt') out.push(isMacPlatform ? '⌥' : 'Alt')
    else if (p === 'ctrl') out.push(isMacPlatform ? '⌃' : 'Ctrl')
  }
  const key = parts[parts.length - 1]
  out.push(
    key === '\\'
      ? '\\'
      : key === '?'
        ? '?'
        : key === 'escape'
          ? 'Esc'
          : key === 'enter'
            ? 'Enter'
            : key.toUpperCase(),
  )
  return out.join(isMacPlatform ? '' : '+')
}

function matches(chord: Chord, e: KeyboardEvent): boolean {
  const modDown = isMacPlatform ? e.metaKey : e.ctrlKey
  if (chord.mod !== modDown) return false
  if (chord.alt !== (e.altKey || (isMacPlatform && e.ctrlKey && !chord.mod))) return false
  // `?` already implies Shift on most layouts, so compare the produced key.
  if (chord.key !== '?' && chord.shift !== e.shiftKey) return false
  return e.key.toLowerCase() === chord.key
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, [contenteditable="true"]') !== null)
  )
}

// --- user remapping ----------------------------------------------------------

let overrides: Record<string, string> = {}

/** Apply the user's remaps (`ui.shortcuts`). Unknown ids are ignored. */
export function setShortcutOverrides(next: Record<string, string>) {
  overrides = next
}

export function chordFor(id: string): string {
  return overrides[id] ?? BY_ID.get(id)?.defaultChord ?? ''
}

/**
 * Action ids that resolve to the same chord in the same scope. Surfaced in the
 * cheat sheet so a bad remap is visible rather than mysteriously inert.
 */
export function conflicts(): string[][] {
  const seen = new Map<string, string[]>()
  for (const def of SHORTCUTS) {
    if (def.displayOnly) continue
    const key = `${def.scope}:${chordFor(def.id)}`
    seen.set(key, [...(seen.get(key) ?? []), def.id])
  }
  return [...seen.values()].filter((ids) => ids.length > 1)
}

// --- dispatch ----------------------------------------------------------------

type Handler = (e: KeyboardEvent) => void
type Registration = { id: string; scope: ShortcutScope; handler: Handler }

// Most-recently-registered first, so a modal registered after a pane wins.
const registrations: Registration[] = []

/** Bind a handler to an action id. Returns an unregister function. */
export function registerShortcut(id: string, handler: Handler): () => void {
  const def = BY_ID.get(id)
  if (!def) {
    // A typo'd id would otherwise be a silently dead key.
    console.warn(`[shortcuts] unknown action "${id}"`)
    return () => {}
  }
  const reg: Registration = { id, scope: def.scope, handler }
  registrations.unshift(reg)
  return () => {
    const at = registrations.indexOf(reg)
    if (at >= 0) registrations.splice(at, 1)
  }
}

const SCOPE_RANK: Record<ShortcutScope, number> = { overlay: 2, pane: 1, global: 0 }

function onKeyDown(e: KeyboardEvent) {
  const editable = isEditableTarget(e.target)
  let best: Registration | null = null
  let bestRank = -1
  for (const reg of registrations) {
    const def = BY_ID.get(reg.id)
    if (!def) continue
    const chord = parseChord(chordFor(reg.id))
    if (!matches(chord, e)) continue
    if (editable && !def.allowInInput && !chord.mod) continue
    const rank = SCOPE_RANK[reg.scope]
    if (rank > bestRank) {
      best = reg
      bestRank = rank
    }
  }
  if (best) best.handler(e)
}

let installed = false

/** Install the single global listener. Idempotent. */
export function installShortcuts(): () => void {
  if (installed || typeof window === 'undefined') return () => {}
  installed = true
  window.addEventListener('keydown', onKeyDown)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
    installed = false
  }
}

/** Cheat-sheet rows, grouped, with the user's active chords resolved. */
export function shortcutGroups(): { group: string; items: ShortcutDef[] }[] {
  const out = new Map<string, ShortcutDef[]>()
  for (const def of SHORTCUTS) {
    if (def.hidden) continue
    out.set(def.group, [...(out.get(def.group) ?? []), def])
  }
  return [...out.entries()].map(([group, items]) => ({ group, items }))
}
