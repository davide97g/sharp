// Settings → Appearance, plus the Sounds section that lives inside it.
//
// Contract: docs/arch/05-files-notifications.md ("Appearance").
//
// Every control here writes through `patchUi`, which persists to the synced blob and
// applies the change live via lib/store/uiHelpers — never set a CSS variable directly
// from a tab, or the preference and the rendering drift apart.

import { useSyncExternalStore } from 'react'
import { useStore } from '../../store'
import { EVENT_PACKS, activePack, type EventPack } from '../../lib/seasonal'
import {
  getSoundSettings,
  setSoundPack,
  setSoundSettings,
  sound,
  subscribeSoundSettings,
} from '../../lib/sound'
import { Button, ChoiceCard, SectionLabel } from '../../ui'
import { ThemePicker } from '../ThemePicker'
import { NavigationPicker } from '../NavigationPicker'
import { DARK_THEMES, LIGHT_THEMES, resolveScheme } from '../../lib/theme'
import type {
  ColorScheme,
  Density,
  SoundPack,
  UiPrefs,
} from '../../lib/uiPrefs'
import { DockAutoHideSwitch, Segmented, ToggleRow } from './shared'


export const EFFECT_CHOICES: { key: keyof UiPrefs['effects']; label: string; desc: string }[] = [
  { key: 'glass', label: 'Glass', desc: 'Translucent, blurred panels.' },
  { key: 'grain', label: 'Film grain', desc: 'A fine noise texture over everything.' },
  { key: 'glow', label: 'Accent glow', desc: 'Halo around accent-coloured elements.' },
  { key: 'scanlines', label: 'Scanlines', desc: 'CRT-style horizontal lines.' },
]

export const SOUND_PACK_CHOICES: { value: SoundPack; label: string; desc: string }[] = [
  { value: 'default', label: 'Default', desc: 'Sharp’s house voice.' },
  { value: 'minimal', label: 'Minimal', desc: 'Shorter, softer, barely there.' },
  { value: 'retro', label: 'Retro', desc: 'Square-wave 8-bit blips.' },
  { value: 'nature', label: 'Nature', desc: 'Airy, long-tailed, chorused.' },
  { value: 'mechanical', label: 'Mechanical', desc: 'Short and clicky.' },
]

// ---- Privacy tab ----

export const SCHEME_CHOICES: { value: ColorScheme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
]

export const DENSITY_CHOICES: { value: Density; label: string; desc: string }[] = [
  { value: 'cozy', label: 'Cozy', desc: 'Roomy rows, full-size avatars.' },
  { value: 'compact', label: 'Compact', desc: 'Tighter rows, more on screen.' },
  { value: 'ultra', label: 'Ultra', desc: 'Maximum density, minimal chrome.' },
]

export const SCALE_CHOICES: { value: number; label: string }[] = [
  { value: 0.9, label: 'Small' },
  { value: 1, label: 'Default' },
  { value: 1.1, label: 'Large' },
]


const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** `Oct 24 – Nov 1` — the pack's yearly window, for the preview cards. */
function packWindow(pack: EventPack): string {
  const day = ([m, d]: [number, number]) => `${MONTHS[m - 1]} ${d}`
  return `${day(pack.from)} – ${day(pack.to)}`
}

export function AppearanceSettings() {
  const ui = useStore((s) => s.ui)
  const patchUi = useStore((s) => s.patchUi)
  const seasonPreview = useStore((s) => s.seasonPreview)
  const setSeasonPreview = useStore((s) => s.setSeasonPreview)
  // What is actually on screen right now — with scheme 'system' this follows
  // the OS, so the picker must offer that scheme's presets, not the stored one.
  const scheme = resolveScheme(ui.scheme)
  const seasonalPack = activePack(undefined, seasonPreview)
  const themes = scheme === 'light' ? LIGHT_THEMES : DARK_THEMES
  const activeTheme = scheme === 'light' ? ui.themeLight : ui.theme
  const hue = ui.accentHue

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel size="xs">Color scheme</SectionLabel>
      <Segmented
        value={ui.scheme}
        options={SCHEME_CHOICES}
        onChange={(value) => patchUi({ scheme: value })}
      />
      <p className="text-2xs text-text-faint">
        {ui.scheme === 'system'
          ? 'Following your device — sharp switches when your OS does.'
          : 'Synced to your account, so every device you sign in on matches.'}
      </p>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Theme
        </SectionLabel>
        <ThemePicker
          themes={themes}
          value={activeTheme}
          onChange={(preset) =>
            patchUi(scheme === 'light' ? { themeLight: preset } : { theme: preset })
          }
        />
        <p className="mt-3 text-2xs text-text-faint">
          {ui.scheme === 'system'
            ? 'Light and dark keep separate picks — switch the scheme above to choose the other one.'
            : 'Themes change colors only — layout stays the same.'}
        </p>
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Accent color
        </SectionLabel>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={359}
            value={hue ?? 265}
            aria-label="Accent hue"
            onChange={(e) => patchUi({ accentHue: Number(e.target.value) })}
            className="range-slider flex-1"
            style={{
              // The full hue wheel at the accent's own lightness/chroma, so the
              // track previews exactly what each position produces.
              background:
                'linear-gradient(to right, ' +
                [0, 60, 120, 180, 240, 300, 359]
                  .map((h) =>
                    scheme === 'light'
                      ? `oklch(0.55 0.17 ${h})`
                      : `oklch(0.68 0.16 ${h})`,
                  )
                  .join(',') +
                ')',
            }}
          />
          <span
            className="h-6 w-6 shrink-0 rounded-full border border-border"
            style={{ backgroundColor: 'var(--color-accent)' }}
          />
          <Button
            size="xs"
            variant="ghost"
            disabled={hue === null}
            onClick={() => patchUi({ accentHue: null })}
          >
            Reset
          </Button>
        </div>
        <p className="mt-2 text-2xs text-text-faint">
          {hue === null
            ? 'Using the theme’s own accent.'
            : 'Overrides the theme accent on every preset. Brightness is fixed so the accent stays readable.'}
        </p>
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Density
        </SectionLabel>
        <div className="grid grid-cols-3 gap-3">
          {DENSITY_CHOICES.map((d) => (
            <ChoiceCard
              key={d.value}
              selected={ui.density === d.value}
              onSelect={() => patchUi({ density: d.value })}
              title={d.label}
              description={d.desc}
              selectedStyle="ring"
            />
          ))}
        </div>
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Interface scale
        </SectionLabel>
        <Segmented
          value={ui.fontScale}
          options={SCALE_CHOICES}
          onChange={(value) => patchUi({ fontScale: value })}
        />
        <p className="mt-2 text-2xs text-text-faint">
          Scales text, spacing, and panel widths together.
        </p>
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Motion
        </SectionLabel>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={150}
            step={10}
            value={Math.round(ui.motion * 100)}
            aria-label="Animation speed"
            onChange={(e) => patchUi({ motion: Number(e.target.value) / 100 })}
            className="range-slider flex-1"
            style={{
              background: `linear-gradient(to right, var(--color-accent) ${(ui.motion / 1.5) * 100}%, var(--color-panel) ${(ui.motion / 1.5) * 100}%)`,
            }}
          />
          <span className="w-16 text-right text-xs tabular-nums text-text-dim">
            {ui.motion === 0 ? 'Still' : `${Math.round(ui.motion * 100)}%`}
          </span>
        </div>
        <p className="mt-2 text-2xs text-text-faint">
          Animation duration multiplier. If your system asks for reduced motion,
          sharp already honors that regardless of this setting.
        </p>
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Focus mode
        </SectionLabel>
        <ToggleRow
          title="Strip everything decorative"
          description="No effects, wallpapers, or celebrations. Turns itself on while you share a screen."
          checked={ui.focusMode}
          onChange={(focusMode) => patchUi({ focusMode })}
        />
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Effects
        </SectionLabel>
        <div className="flex flex-col gap-3">
          {EFFECT_CHOICES.map((e) => (
            <ToggleRow
              key={e.key}
              title={e.label}
              description={e.desc}
              checked={ui.effects[e.key]}
              onChange={(on) => patchUi({ effects: { ...ui.effects, [e.key]: on } })}
            />
          ))}
          <ToggleRow
            title="Celebrations"
            description="Confetti when a task is completed or a poll closes."
            checked={ui.celebrations}
            onChange={(celebrations) => patchUi({ celebrations })}
          />
        </div>
        {ui.focusMode && (
          <p className="mt-3 text-2xs text-warning-fg">
            Focus mode is on, so none of these are showing right now.
          </p>
        )}
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Seasonal
        </SectionLabel>
        <Segmented
          value={ui.seasonal}
          options={[
            { value: 'off' as const, label: 'Off' },
            { value: 'subtle' as const, label: 'Subtle' },
            { value: 'full' as const, label: 'Full' },
          ]}
          onChange={(value) => patchUi({ seasonal: value })}
        />
        <p className="mt-2 text-2xs text-text-faint">
          {seasonPreview && seasonalPack
            ? `Previewing ${seasonalPack.name}. `
            : seasonalPack
              ? `${seasonalPack.name} is running now. `
              : 'Nothing running today. '}
          Subtle recolours the accent and swaps a few words; Full adds falling
          particles.
        </p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <SectionLabel size="xs">Try it now</SectionLabel>
          <Button
            size="xs"
            variant="ghost"
            disabled={!seasonPreview}
            onClick={() => setSeasonPreview(null)}
          >
            Reset
          </Button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {EVENT_PACKS.map((pack) => (
            <ChoiceCard
              key={pack.id}
              selected={seasonPreview === pack.id}
              onSelect={() =>
                setSeasonPreview(seasonPreview === pack.id ? null : pack.id)
              }
              title={pack.name}
              description={packWindow(pack)}
              selectedStyle="ring"
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-4 w-4 shrink-0 rounded-full"
                  style={{
                    // The pack's own accent at the current scheme's lightness —
                    // exactly what applying it produces.
                    backgroundColor:
                      scheme === 'light'
                        ? `oklch(0.55 0.17 ${pack.accentHue})`
                        : `oklch(0.68 0.16 ${pack.accentHue})`,
                  }}
                />
                <span className="truncate text-xs leading-none">
                  {pack.reactions.slice(0, 4).join('')}
                </span>
              </div>
            </ChoiceCard>
          ))}
        </div>
        <p className="mt-2 text-2xs text-text-faint">
          Pins a pack regardless of the date, on this device only — it is a
          preview, so it never syncs to your other devices. Reset hands control
          back to the calendar.
        </p>
        {seasonPreview && ui.seasonal === 'off' && (
          <p className="mt-2 text-2xs text-warning-fg">
            Seasonal is Off, so the preview is not showing — pick Subtle or Full.
          </p>
        )}
        {seasonPreview && ui.seasonal === 'subtle' && seasonalPack?.effect && (
          <p className="mt-2 text-2xs text-text-faint">
            Full intensity would also add {seasonalPack.effect}.
          </p>
        )}
        {seasonPreview && ui.focusMode && (
          <p className="mt-2 text-2xs text-warning-fg">
            Focus mode is on, which overrides seasonal packs entirely.
          </p>
        )}
        {seasonPreview && ui.accentHue !== null && (
          <p className="mt-2 text-2xs text-warning-fg">
            Your accent override wins over the pack colour — reset it above to
            see {seasonalPack?.name}’s hue.
          </p>
        )}
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Sound pack
        </SectionLabel>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {SOUND_PACK_CHOICES.map((p) => (
            <ChoiceCard
              key={p.value}
              selected={ui.soundPack === p.value}
              onSelect={() => {
                patchUi({ soundPack: p.value })
                // Apply before previewing so the tick is in the new voice.
                setSoundPack(p.value)
                sound.messageReceived()
              }}
              title={p.label}
              description={p.desc}
              selectedStyle="ring"
            />
          ))}
        </div>
        <p className="mt-2 text-2xs text-text-faint">
          Every sound is synthesized live — a pack retunes them, it does not swap
          in audio files. Volume and the on/off switch live under Notifications.
        </p>
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Navigation
        </SectionLabel>
        <NavigationPicker
          value={ui.railPosition}
          onChange={(position) => patchUi({ railPosition: position })}
        />
        {ui.railPosition !== 'left' && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2">
            <div>
              <div className="text-sm font-medium text-text">
                Automatically hide the dock
              </div>
              <div className="text-2xs text-text-faint">
                {ui.railPosition === 'top'
                  ? 'The dock tucks into a notch. Move the cursor to the notch to show it.'
                  : 'The dock slides away. Move the cursor to the bottom edge to show it.'}
              </div>
            </div>
            <DockAutoHideSwitch
              checked={ui.dockAutoHide}
              onChange={(autoHide) => patchUi({ dockAutoHide: autoHide })}
            />
          </div>
        )}
        <p className="mt-3 text-2xs text-text-faint">
          Desktop only. Mobile always uses its bottom tabs.
        </p>
      </div>
    </div>
  )
}

export function SoundSettingsSection() {
  const settings = useSyncExternalStore(
    subscribeSoundSettings,
    getSoundSettings,
    getSoundSettings,
  )
  const pct = Math.round(settings.volume * 100)
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel size="xs">Sounds</SectionLabel>
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => {
            setSoundSettings({ enabled: e.target.checked })
            if (e.target.checked) sound.previewTick()
          }}
          className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-sm font-medium text-[var(--color-text)]">
            Interface sounds
          </span>
          <span className="mt-1 block text-xs text-[var(--color-text-faint)]">
            Crisp synthesized cues for messages, calls, and navigation.
          </span>
        </span>
      </label>
      <div>
        <SectionLabel as="label" size="xs" className="mb-2 block">Volume</SectionLabel>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            value={pct}
            disabled={!settings.enabled}
            onChange={(e) => {
              setSoundSettings({ volume: Number(e.target.value) / 100 })
              // Preview at the new level so dragging is audible feedback.
              sound.previewTick()
            }}
            className="range-slider flex-1 disabled:cursor-default disabled:opacity-50"
            style={{
              // Filled portion up to the thumb, then the empty track color.
              background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-panel) ${pct}%)`,
            }}
          />
          <span className="w-10 text-right text-xs tabular-nums text-[var(--color-text-dim)]">
            {pct}%
          </span>
        </div>
      </div>
    </div>
  )
}

// ---- Notifications tab ----

