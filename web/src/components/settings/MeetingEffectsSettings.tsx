// Settings → Meetings: the audio-aura avatar effect and its style.
//
// Device-local (lib/meetingEffects.ts), not synced: it depends on this machine's
// rendering budget.

import { useStore } from '../../store'
import { SectionLabel } from '../../ui'
import {
  setAudioAuraPreference,
  useAudioAuraPreference,
  useAudioAuraStyle,
  type AudioAuraStyle,
} from '../../lib/meetingEffects'
import { AudioAuraPreview } from '../voice/AudioAuraAvatar'


export function MeetingEffectsSettings({ userId }: { userId: string }) {
  const preference = useAudioAuraPreference(userId)
  const auraStyle = useAudioAuraStyle(userId)
  const setVoiceAuraStyle = useStore((s) => s.setVoiceAuraStyle)
  const enabled = preference === true

  const auraOptions: Array<{
    id: AudioAuraStyle
    name: string
    mood: string
    description: string
    pick?: boolean
  }> = [
    { id: 'helios', name: 'Helios', mood: 'Radiant', description: 'Voice erupts as a hot solar corona.', pick: true },
    { id: 'mercury', name: 'Mercury', mood: 'Liquid', description: 'Viscous chrome reshapes around every phrase.' },
    { id: 'voiceprint', name: 'Voiceprint', mood: 'Graphic', description: 'A tiny live waveform frames your face.' },
    { id: 'kinetic-type', name: 'Kinetic Type', mood: 'Loud', description: 'Conversation fragments punch through the frame.' },
    { id: 'eclipse', name: 'Eclipse', mood: 'Minimal', description: 'A dark halo releases clean shockwaves.' },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div>
        <SectionLabel size="xs">Speaking effects</SectionLabel>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-faint)]">
          Optional visual effects shown during calls. Your microphone audio stays on device.
        </p>
      </div>
      <label className="group flex cursor-pointer items-center gap-4 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-2)] p-4 transition-colors hover:border-[#796cff]/45">
        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-[radial-gradient(circle,#796cff22,transparent_70%)]">
          <AudioAuraPreview size={46} variant={auraStyle} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--color-text)]">Audio Aura</span>
            <span className="rounded-full bg-[#796cff]/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-[#a99fff]">
              Advanced
            </span>
          </span>
          <span id="audio-aura-setting-description" className="mt-1 block text-xs leading-5 text-[var(--color-text-faint)]">
            Speaking volume drives a visual signature around your avatar.
          </span>
          <span className="mt-1 block text-3xs font-medium text-[var(--color-text-dim)]">
            {preference === null ? 'Not decided — you will be asked once in a call.' : enabled ? 'On' : 'Off'}
          </span>
        </span>
        <span className="relative flex h-7 w-12 shrink-0 items-center rounded-full bg-[var(--color-border)] p-1 transition-colors has-[:checked]:bg-[#796cff]">
          <input
            type="checkbox"
            checked={enabled}
            aria-describedby="audio-aura-setting-description"
            onChange={(event) => setAudioAuraPreference(userId, event.target.checked)}
            className="peer sr-only"
          />
          <span className="h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
        </span>
      </label>
      <fieldset disabled={!enabled} className={`transition-opacity ${enabled ? 'opacity-100' : 'pointer-events-none opacity-45'}`}>
        <legend className="mb-2 text-3xs font-bold uppercase tracking-[0.16em] text-[var(--color-text-faint)]">
          Choose your aura
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {auraOptions.map((option) => {
            const selected = auraStyle === option.id
            return (
              <label
                key={option.id}
                className={`group relative flex min-h-[108px] cursor-pointer items-center gap-3 overflow-hidden rounded-xl border p-3 outline-none transition-colors focus-within:ring-2 focus-within:ring-[var(--color-accent)] ${
                  selected
                    ? 'border-[#8b7cff] bg-[#796cff]/10'
                    : 'border-[var(--color-border)] bg-[var(--color-panel-2)] hover:border-[#796cff]/40'
                }`}
              >
                <input
                  type="radio"
                  name="audio-aura-style"
                  value={option.id}
                  checked={selected}
                  onChange={() => setVoiceAuraStyle(option.id)}
                  className="sr-only"
                />
                <span className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-2xl bg-[radial-gradient(circle,#796cff18,transparent_72%)]">
                  <AudioAuraPreview size={42} variant={option.id} />
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-bold text-[var(--color-text)]">{option.name}</span>
                    {option.pick ? (
                      <span className="rounded-full bg-[#ff805f]/15 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-[0.12em] text-[#ff987f]">
                        My pick
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[9px] font-bold uppercase tracking-[0.14em] text-[#9c8fff]">
                    {option.mood}
                  </span>
                  <span className="mt-1 block text-3xs leading-4 text-[var(--color-text-faint)]">
                    {option.description}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={`absolute right-2 top-2 h-2 w-2 rounded-full border ${selected ? 'border-[#a99fff] bg-[#796cff] shadow-[0_0_8px_#796cff]' : 'border-[var(--color-border)]'}`}
                />
              </label>
            )
          })}
        </div>
      </fieldset>
      <p className="text-2xs leading-5 text-[var(--color-text-faint)]">
        Honors your system’s reduced-motion preference by replacing movement with a static glow.
      </p>
    </div>
  )
}
