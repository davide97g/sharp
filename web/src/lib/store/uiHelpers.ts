// Apply an appearance preference blob to the store *and* to the live app.
//
// Contract: docs/arch/05-files-notifications.md ("Appearance").
//
// One function so the seven places that can change appearance — settings UI, the
// `prefs.updated` event from another device, login hydration, streaming mode, seasonal
// themes — cannot each remember a different subset of the side effects. Everything that
// has to happen when `ui` changes happens here: CSS variables, sound engine, sound pack,
// shortcut overrides, celebration config, and the local mirror.

import { adoptSoundSettings, setSoundPack } from '../sound'
import { configureCelebrations } from '../celebrate'
import { setShortcutOverrides } from '../shortcuts'
import { applyUiPrefs } from '../theme'
import type { UiPrefs } from '../uiPrefs'
import type { State } from '../../store'

export function applyUi(set: (partial: Partial<State>) => void, next: UiPrefs) {
  set({ ui: next, railPosition: next.railPosition, dockAutoHide: next.dockAutoHide })
  applyUiPrefs(next)
  adoptSoundSettings(next.sounds)
  setSoundPack(next.soundPack)
  setShortcutOverrides(next.shortcuts)
  configureCelebrations({
    enabled: next.celebrations && !next.focusMode,
    motion: next.motion,
  })
}
