import { useState } from 'react'
import type { AudioAuraStyle } from '../../lib/meetingEffects'
import { AudioAuraPreview } from './AudioAuraAvatar'

const CONCEPTS: Array<{
  id: AudioAuraStyle
  number: string
  name: string
  mood: string
  line: string
  detail: string
  pick?: boolean
}> = [
  {
    id: 'helios',
    number: '01',
    name: 'Helios',
    mood: 'Radiant / magnetic',
    line: 'Voice becomes sunlight.',
    detail: 'Corona length, heat, and rotation answer your volume.',
    pick: true,
  },
  {
    id: 'mercury',
    number: '02',
    name: 'Mercury',
    mood: 'Liquid / uncanny',
    line: 'Polished sound, literally.',
    detail: 'A viscous chrome body reforms around every phrase.',
  },
  {
    id: 'voiceprint',
    number: '03',
    name: 'Voiceprint',
    mood: 'Graphic / precise',
    line: 'Your voice gets a silhouette.',
    detail: 'Eleven bars make a live frame, not another equalizer badge.',
  },
  {
    id: 'kinetic-type',
    number: '04',
    name: 'Kinetic Type',
    mood: 'Chaotic / social',
    line: 'Conversation breaks frame.',
    detail: 'Words and punctuation punch out on vocal peaks.',
  },
  {
    id: 'eclipse',
    number: '05',
    name: 'Eclipse',
    mood: 'Minimal / expensive',
    line: 'Quiet look. Heavy presence.',
    detail: 'A black halo releases one cold, clean shockwave.',
  },
]

export function AudioAuraShowcase() {
  const [level, setLevel] = useState(0.82)

  return (
    <main className="aura-showcase min-h-dvh overflow-x-hidden bg-[#0b0710] px-4 py-8 text-[#f7f1ff] sm:px-8 lg:px-12">
      <div className="mx-auto max-w-[1380px]">
        <header className="grid gap-7 border-b border-white/10 pb-8 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <div className="flex items-center gap-3 text-[10px] font-black uppercase tracking-[0.28em] text-[#9f91ae]">
              <span className="h-px w-8 bg-[#ff805f]" />
              Audio Aura / direction study
            </div>
            <h1 className="mt-3 text-[clamp(3.4rem,9vw,8rem)] font-black leading-[0.78] tracking-[-0.075em] text-white">
              AURA
              <span className="ml-[0.08em] text-[#9b86ff]">FARM</span>
            </h1>
            <p className="mt-5 max-w-xl text-sm leading-6 text-[#aa9fb6] sm:text-base">
              Five ways to be heard before you finish the sentence. No orbiting dots. No loading-spinner energy.
            </p>
          </div>

          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.035] p-4 lg:w-[340px]">
            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.18em] text-[#9f91ae]">
              <label htmlFor="aura-energy">Simulated voice energy</label>
              <span className="font-mono text-[#ffb28f]">{Math.round(level * 100)}%</span>
            </div>
            <input
              id="aura-energy"
              type="range"
              min="0.18"
              max="1"
              step="0.01"
              value={level}
              onChange={(event) => setLevel(Number(event.target.value))}
              className="mt-4 h-1.5 w-full cursor-pointer accent-[#8f79ff]"
            />
            <div className="mt-3 flex justify-between font-mono text-[9px] uppercase tracking-[0.12em] text-[#675f70]">
              <span>Murmur</span><span>Room</span><span>Peak</span>
            </div>
          </div>
        </header>

        <section className="grid gap-px overflow-hidden border-x border-b border-white/10 bg-white/10 sm:grid-cols-2 xl:grid-cols-5" aria-label="Five Audio Aura concepts">
          {CONCEPTS.map((concept) => (
            <article
              key={concept.id}
              className={`aura-showcase-card aura-showcase-card-${concept.id} relative flex min-h-[390px] flex-col overflow-hidden bg-[#100b16] p-5 sm:min-h-[420px]`}
            >
              <div className="flex items-start justify-between">
                <span className="font-mono text-[11px] text-[#655d6e]">{concept.number} / 05</span>
                {concept.pick ? (
                  <span className="rounded-full border border-[#ff8b69]/40 bg-[#ff805f]/10 px-2 py-1 text-[8px] font-black uppercase tracking-[0.16em] text-[#ffae93]">
                    My pick
                  </span>
                ) : null}
              </div>

              <div className="relative flex min-h-[205px] flex-1 items-center justify-center">
                <span className="aura-showcase-grid" aria-hidden="true" />
                <AudioAuraPreview size={88} variant={concept.id} level={level} />
              </div>

              <div className="relative z-10 border-t border-white/10 pt-4">
                <div className="text-[9px] font-black uppercase tracking-[0.2em] text-[#9b86ff]">{concept.mood}</div>
                <h2 className="mt-1 text-[28px] font-black leading-none tracking-[-0.04em] text-white">{concept.name}</h2>
                <p className="mt-3 text-sm font-semibold text-[#ece4f4]">{concept.line}</p>
                <p className="mt-1.5 text-[11px] leading-[1.55] text-[#8e8499]">{concept.detail}</p>
              </div>
            </article>
          ))}
        </section>

        <footer className="flex flex-col gap-2 py-5 text-[9px] font-bold uppercase tracking-[0.16em] text-[#5f5767] sm:flex-row sm:items-center sm:justify-between">
          <span>Reactive input: microphone amplitude</span>
          <span>Motion-safe fallback: static signature glow</span>
        </footer>
      </div>
    </main>
  )
}
