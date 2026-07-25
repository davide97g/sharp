// Actions for the command palette (`>` prefix in ⌘K).
//
// The palette used to be navigation-only: it could take you to a channel but
// could not *do* anything. These are the verbs. Each one is a plain object with
// a `run`, so adding a command is a one-liner and the palette stays dumb.

import type { NavigateFunction } from 'react-router-dom'
import { useStore } from '../store'
import { DENSITIES } from './uiPrefs'
import { setSoundSettings, getSoundSettings } from './sound'

export type Command = {
  id: string
  label: string
  /** Right-aligned hint: current value, destination, that sort of thing. */
  hint?: string
  icon: string
  run: () => void
}

export function buildCommands(navigate: NavigateFunction): Command[] {
  const st = useStore.getState()
  const ui = st.ui
  const nextDensity = DENSITIES[(DENSITIES.indexOf(ui.density) + 1) % DENSITIES.length]
  const sounds = getSoundSettings()

  const go = (path: string) => () => navigate(path)

  return [
    // Channel creation and browsing live in the sidebar's local state, so the
    // palette routes to the surface rather than reaching into another
    // component — a global modal store would be a heavier change than the
    // command warrants.
    { id: 'cmd.tasks', label: 'Go to Tasks', icon: '🎯', run: go('/tasks') },
    { id: 'cmd.docs', label: 'Go to Docs', icon: '📄', run: go('/docs') },
    { id: 'cmd.canvas', label: 'Go to Canvas', icon: '🎨', run: go('/canvas') },
    { id: 'cmd.meetings', label: 'Go to Meetings', icon: '📹', run: go('/meetings') },
    { id: 'cmd.sharpy', label: 'Ask Sharpy', icon: '✦', run: go('/sharpy') },
    { id: 'cmd.read.all', label: 'Mark all notifications read', icon: '✓', run: () => st.markAllNotifRead() },
    {
      id: 'cmd.scheme',
      label: 'Switch colour scheme',
      hint: ui.scheme,
      icon: '◐',
      run: () =>
        st.patchUi({
          scheme: ui.scheme === 'dark' ? 'light' : ui.scheme === 'light' ? 'system' : 'dark',
        }),
    },
    {
      id: 'cmd.focus',
      label: ui.focusMode ? 'Turn off Focus mode' : 'Turn on Focus mode',
      hint: ui.focusMode ? 'on' : 'off',
      icon: '◎',
      run: () => st.patchUi({ focusMode: !ui.focusMode }),
    },
    {
      id: 'cmd.density',
      label: `Density: switch to ${nextDensity}`,
      hint: ui.density,
      icon: '≡',
      run: () => st.patchUi({ density: nextDensity }),
    },
    {
      id: 'cmd.sounds',
      label: sounds.enabled ? 'Mute interface sounds' : 'Unmute interface sounds',
      hint: sounds.enabled ? 'on' : 'off',
      icon: '♪',
      run: () => setSoundSettings({ enabled: !sounds.enabled }),
    },
    {
      id: 'cmd.dnd',
      label: st.dnd ? 'Turn off Do Not Disturb' : 'Turn on Do Not Disturb',
      hint: st.dnd ? 'on' : 'off',
      icon: '⏾',
      run: () => void st.setDnd(!st.dnd),
    },
    {
      id: 'cmd.turbo',
      label: 'Turbo mode: strip motion and go dense',
      hint: 'preset',
      icon: '⚡',
      run: () =>
        st.patchUi({
          motion: 0,
          density: 'ultra',
          celebrations: false,
          effects: { glass: false, grain: false, glow: false, scanlines: false },
        }),
    },
    { id: 'cmd.settings.appearance', label: 'Settings: Appearance', icon: '⚙', run: go('/settings/appearance') },
    { id: 'cmd.settings.chat', label: 'Settings: Chat', icon: '⚙', run: go('/settings/chat') },
    { id: 'cmd.settings.notifications', label: 'Settings: Notifications', icon: '⚙', run: go('/settings/notifications') },
    { id: 'cmd.help', label: 'Open Help', icon: '?', run: go('/help') },
  ]
}
