// The app's single WebAudio sound engine. Every UI sound in sharp is synthesized
// here on the fly — there are no audio asset files to ship.
//
// Signal chain: per-sound voices → master gain (volume setting) → gentle limiter
// (DynamicsCompressor) → destination. The limiter is what keeps layered sounds
// crisp and click-free when several fire at once.
//
// Design rules for every voice, so nothing ever clicks or machine-guns:
//   - gain envelopes always ramp from/to 0.0001 (exponential can't reach 0), with
//     short attacks; oscillators stop shortly after the tail.
//   - a per-key rate limiter drops repeats that arrive too fast.
//   - the whole thing is fire-and-forget: play calls never throw into the UI, and
//     if the AudioContext can't start (autoplay policy) the sound is dropped, not
//     queued — no backlog of stale blips.

export type SoundSettings = { enabled: boolean; volume: number }

const STORAGE_KEY = 'sharp.sounds'
const DEFAULTS: SoundSettings = { enabled: true, volume: 0.7 }

function loadSettings(): SoundSettings {
  if (typeof window === 'undefined') return { ...DEFAULTS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<SoundSettings>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
      volume:
        typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
          ? Math.min(1, Math.max(0, parsed.volume))
          : DEFAULTS.volume,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

let settings = loadSettings()
const listeners = new Set<() => void>()

export function getSoundSettings(): SoundSettings {
  return settings
}

/** Merge a patch into the sound settings, persist it, and notify subscribers. */
export function setSoundSettings(patch: Partial<SoundSettings>) {
  settings = {
    enabled: patch.enabled ?? settings.enabled,
    volume:
      patch.volume !== undefined
        ? Math.min(1, Math.max(0, patch.volume))
        : settings.volume,
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* storage unavailable — keep the in-memory value */
  }
  if (master && ctx) {
    // Smoothly track the new volume so dragging the slider doesn't zipper.
    master.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.02)
  }
  for (const fn of listeners) fn()
}

/** Subscribe to settings changes (for a reactive settings UI). Returns unsubscribe. */
export function subscribeSoundSettings(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// --- audio graph (lazily created; may start suspended before a user gesture) ---

let ctx: AudioContext | null = null
let master: GainNode | null = null
let limiter: DynamicsCompressorNode | null = null
let noiseBuf: AudioBuffer | null = null
let gestureHooked = false

function ensureContext(): { ctx: AudioContext; out: AudioNode } | null {
  if (typeof window === 'undefined') return null
  if (ctx && master) return { ctx, out: master }
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  ctx = new Ctor()
  master = ctx.createGain()
  master.gain.value = settings.volume
  limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -18
  limiter.knee.value = 24
  limiter.ratio.value = 5
  limiter.attack.value = 0.003
  limiter.release.value = 0.18
  master.connect(limiter)
  limiter.connect(ctx.destination)
  return { ctx, out: master }
}

// One-time gesture hooks so a context that started suspended (cold load, before
// any click) resumes as soon as the user does anything — later sounds then play.
function hookGestures() {
  if (gestureHooked || typeof window === 'undefined') return
  gestureHooked = true
  const resume = () => {
    if (ctx && ctx.state === 'suspended') void ctx.resume()
  }
  window.addEventListener('pointerdown', resume, { passive: true })
  window.addEventListener('keydown', resume, { passive: true })
}
if (typeof window !== 'undefined') hookGestures()

function whiteNoise(context: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === context.sampleRate) return noiseBuf
  const len = Math.floor(context.sampleRate * 1.2)
  const buf = context.createBuffer(1, len, context.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  noiseBuf = buf
  return buf
}

// --- per-key throttle ---

const lastPlayed = new Map<string, number>()

function throttled(key: string, minGap: number): boolean {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const prev = lastPlayed.get(key)
  if (prev !== undefined && now - prev < minGap) return true
  lastPlayed.set(key, now)
  return false
}

/**
 * Run a voice-building callback inside the shared graph. Handles the enabled
 * gate, throttle, context resume, and error isolation so every trigger is a safe
 * one-liner. `build` receives the context, a start time, and the master input.
 */
function play(
  key: string,
  minGap: number,
  build: (context: AudioContext, t0: number, out: AudioNode) => void,
): void {
  if (!settings.enabled) return
  if (throttled(key, minGap)) return
  try {
    const graph = ensureContext()
    if (!graph) return
    const { ctx: context, out } = graph
    void context.resume()
    // If the context is still suspended (autoplay policy, no gesture yet) drop
    // the sound rather than letting it queue up and fire in a burst later.
    if (context.state === 'suspended') return
    build(context, context.currentTime + 0.001, out)
  } catch {
    /* audio unavailable — never surface to the UI */
  }
}

// --- voice primitives ---

type EnvOpts = { attack?: number; hold?: number; decay: number; peak: number }

/** A gain node with a click-free attack/hold/decay envelope, connected to `out`. */
function envGain(
  context: AudioContext,
  out: AudioNode,
  t0: number,
  { attack = 0.008, hold = 0, decay, peak }: EnvOpts,
): { node: GainNode; endsAt: number } {
  const g = context.createGain()
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack)
  if (hold > 0) g.gain.setValueAtTime(peak, t0 + attack + hold)
  const endsAt = t0 + attack + hold + decay
  g.gain.exponentialRampToValueAtTime(0.0001, endsAt)
  g.connect(out)
  return { node: g, endsAt }
}

type ToneOpts = EnvOpts & {
  freq: number
  freqEnd?: number
  type?: OscillatorType
  detune?: number // cents; adds a second detuned oscillator for warmth
}

/** A single (optionally detuned, optionally pitch-bending) oscillator voice. */
function tone(context: AudioContext, out: AudioNode, t0: number, opts: ToneOpts): number {
  const { node: g, endsAt } = envGain(context, out, t0, opts)
  const type = opts.type ?? 'sine'
  const mk = (detune: number) => {
    const osc = context.createOscillator()
    osc.type = type
    osc.detune.value = detune
    osc.frequency.setValueAtTime(opts.freq, t0)
    if (opts.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(opts.freqEnd, endsAt)
    }
    osc.connect(g)
    osc.start(t0)
    osc.stop(endsAt + 0.03)
  }
  mk(0)
  if (opts.detune) mk(opts.detune)
  return endsAt
}

// --- generic multi-note helper (used by the notification-family sounds) ---

type SynthNote = { freq: number; at: number }

function playNotes(
  key: string,
  minGap: number,
  notes: SynthNote[],
  { volume, decay, wave = 'triangle' }: { volume: number; decay: number; wave?: OscillatorType },
) {
  play(key, minGap, (context, t0, out) => {
    const group = context.createGain()
    group.gain.value = volume
    group.connect(out)
    for (const n of notes) {
      tone(context, group, t0 + n.at, {
        freq: n.freq,
        type: wave,
        attack: 0.012,
        decay,
        peak: 1,
      })
    }
  })
}

// ── Splash / loading ──────────────────────────────────────────────────────

/** Deep bass swell — the signature "deep bass vibration". Felt more than heard. */
function bassSwell() {
  play('splash.bass', 500, (context, t0, out) => {
    // Lowpass sweeps gently upward across the swell for movement.
    const lp = context.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 0.7
    lp.frequency.setValueAtTime(90, t0)
    lp.frequency.exponentialRampToValueAtTime(320, t0 + 1.2)
    lp.connect(out)
    // Sub sine (a hair of detune keeps it alive), plus an octave-up triangle body.
    tone(context, lp, t0, {
      freq: 47,
      detune: 6,
      type: 'sine',
      attack: 0.32,
      hold: 0.35,
      decay: 0.95,
      peak: 0.9,
    })
    tone(context, lp, t0, {
      freq: 94,
      type: 'triangle',
      attack: 0.34,
      hold: 0.2,
      decay: 0.9,
      peak: 0.32,
    })
  })
}

/** Soft high bell ping, timed to the ring pulse. */
function ringPing() {
  play('splash.ring', 200, (context, t0, out) => {
    tone(context, out, t0, {
      freq: 1830,
      detune: 5,
      type: 'sine',
      attack: 0.005,
      decay: 0.34,
      peak: 0.12,
    })
  })
}

/** Quick ascending two-note sparkle, timed to the wordmark slide. Very quiet. */
function shimmer() {
  play('splash.shimmer', 200, (context, t0, out) => {
    tone(context, out, t0, { freq: 2093, type: 'sine', attack: 0.006, decay: 0.18, peak: 0.05 })
    tone(context, out, t0 + 0.07, {
      freq: 2637,
      type: 'sine',
      attack: 0.006,
      decay: 0.2,
      peak: 0.045,
    })
  })
}

/** Playful "squack" blip for the duck landing — cute, quiet, downward bend. */
function squack() {
  play('splash.squack', 200, (context, t0, out) => {
    const lp = context.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1200
    lp.Q.value = 1
    lp.connect(out)
    tone(context, lp, t0, {
      freq: 600,
      freqEnd: 250,
      type: 'sawtooth',
      attack: 0.006,
      decay: 0.14,
      peak: 0.14,
    })
  })
}

/** Airy whoosh for the splash → login handoff flight. Very subtle. */
function whoosh() {
  play('splash.whoosh', 200, (context, t0, out) => {
    const src = context.createBufferSource()
    src.buffer = whiteNoise(context)
    const bp = context.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 1.1
    // Filter frequency sweeps up then back down across the flight.
    bp.frequency.setValueAtTime(500, t0)
    bp.frequency.exponentialRampToValueAtTime(2600, t0 + 0.32)
    bp.frequency.exponentialRampToValueAtTime(700, t0 + 0.66)
    const { node: g, endsAt } = envGain(context, out, t0, {
      attack: 0.12,
      hold: 0.12,
      decay: 0.4,
      peak: 0.06,
    })
    src.connect(bp)
    bp.connect(g)
    src.start(t0)
    src.stop(endsAt + 0.05)
  })
}

/** Warm short ascending confirmation after a successful login. */
function loginSuccess() {
  play('login.success', 300, (context, t0, out) => {
    const group = context.createGain()
    group.gain.value = 0.13
    group.connect(out)
    const notes = [523.25, 659.25, 783.99] // C5 E5 G5
    notes.forEach((freq, i) => {
      tone(context, group, t0 + i * 0.09, {
        freq,
        detune: 4,
        type: 'sine',
        attack: 0.008,
        decay: 0.3,
        peak: 1,
      })
    })
  })
}

// ── Messaging ─────────────────────────────────────────────────────────────

/** Snappy "swoosh-tick" on sending a message. */
function messageSend() {
  play('msg.send', 90, (context, t0, out) => {
    // tiny noise swish
    const src = context.createBufferSource()
    src.buffer = whiteNoise(context)
    const bp = context.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 0.9
    bp.frequency.setValueAtTime(900, t0)
    bp.frequency.exponentialRampToValueAtTime(3200, t0 + 0.06)
    const { node: g, endsAt } = envGain(context, out, t0, { attack: 0.004, decay: 0.07, peak: 0.05 })
    src.connect(bp)
    bp.connect(g)
    src.start(t0)
    src.stop(endsAt + 0.05)
    // high tick
    tone(context, out, t0 + 0.01, { freq: 2000, type: 'sine', attack: 0.004, decay: 0.06, peak: 0.1 })
  })
}

/** Tiny "pop" when adding a reaction. */
function reactionAdd() {
  play('reaction.add', 90, (context, t0, out) => {
    tone(context, out, t0, {
      freq: 300,
      freqEnd: 900,
      type: 'sine',
      attack: 0.005,
      decay: 0.1,
      peak: 0.1,
    })
  })
}

/** Ultra-soft low tick for a message arriving in the focused channel. */
function messageReceived() {
  play('msg.received', 300, (context, t0, out) => {
    const lp = context.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1100
    lp.connect(out)
    tone(context, lp, t0, { freq: 520, type: 'sine', attack: 0.006, decay: 0.09, peak: 0.04 })
  })
}

// ── Voice extras ──────────────────────────────────────────────────────────

function micMute() {
  play('mic.mute', 90, (context, t0, out) => {
    const lp = context.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 900
    lp.connect(out)
    tone(context, lp, t0, { freq: 400, freqEnd: 250, type: 'square', attack: 0.004, decay: 0.05, peak: 0.09 })
  })
}

function micUnmute() {
  play('mic.unmute', 90, (context, t0, out) => {
    const lp = context.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1100
    lp.connect(out)
    tone(context, lp, t0, { freq: 250, freqEnd: 400, type: 'square', attack: 0.004, decay: 0.05, peak: 0.09 })
  })
}

function screenShareStart() {
  play('screen.start', 120, (context, t0, out) => {
    tone(context, out, t0, { freq: 520, type: 'sine', attack: 0.006, decay: 0.12, peak: 0.07 })
    tone(context, out, t0 + 0.09, { freq: 660, type: 'sine', attack: 0.006, decay: 0.14, peak: 0.07 })
  })
}

function screenShareStop() {
  play('screen.stop', 120, (context, t0, out) => {
    tone(context, out, t0, { freq: 660, type: 'sine', attack: 0.006, decay: 0.12, peak: 0.07 })
    tone(context, out, t0 + 0.09, { freq: 520, type: 'sine', attack: 0.006, decay: 0.14, peak: 0.07 })
  })
}

function cameraOn() {
  play('camera.on', 90, (context, t0, out) => {
    const lp = context.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1600
    lp.connect(out)
    tone(context, lp, t0, { freq: 500, freqEnd: 720, type: 'square', attack: 0.004, decay: 0.05, peak: 0.07 })
  })
}

/** Bright two-note rising chime when another participant raises their hand. */
function handRaise() {
  play('hand.raise', 200, (context, t0, out) => {
    const group = context.createGain()
    group.gain.value = 0.12
    group.connect(out)
    // A6 → C#7, a small bright lift that pops above call audio.
    tone(context, group, t0, { freq: 1760, type: 'sine', attack: 0.006, decay: 0.16, peak: 1 })
    tone(context, group, t0 + 0.1, { freq: 2217, type: 'sine', attack: 0.006, decay: 0.2, peak: 0.9 })
  })
}

function cameraOff() {
  play('camera.off', 90, (context, t0, out) => {
    const lp = context.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1600
    lp.connect(out)
    tone(context, lp, t0, { freq: 720, freqEnd: 500, type: 'square', attack: 0.004, decay: 0.05, peak: 0.07 })
  })
}

// ── UI navigation (very subtle — felt, not noticed) ───────────────────────

function modalOpen() {
  play('modal.open', 90, (context, t0, out) => {
    const lp = context.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 500
    lp.connect(out)
    tone(context, lp, t0, { freq: 180, type: 'sine', attack: 0.006, decay: 0.07, peak: 0.08 })
  })
}

function modalClose() {
  play('modal.close', 90, (context, t0, out) => {
    const lp = context.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 460
    lp.connect(out)
    tone(context, lp, t0, { freq: 150, type: 'sine', attack: 0.006, decay: 0.07, peak: 0.08 })
  })
}

function switcherOpen() {
  play('switcher.open', 90, (context, t0, out) => {
    tone(context, out, t0, { freq: 320, type: 'sine', attack: 0.005, decay: 0.08, peak: 0.06 })
    tone(context, out, t0 + 0.03, { freq: 520, type: 'sine', attack: 0.005, decay: 0.1, peak: 0.05 })
  })
}

function modeSwitch() {
  play('mode.switch', 90, (context, t0, out) => {
    tone(context, out, t0, { freq: 660, type: 'sine', attack: 0.005, decay: 0.07, peak: 0.05 })
  })
}

function tabSwitch() {
  play('tab.switch', 110, (context, t0, out) => {
    tone(context, out, t0, { freq: 520, type: 'sine', attack: 0.004, decay: 0.05, peak: 0.03 })
  })
}

// ── Toasts ────────────────────────────────────────────────────────────────

function toastSuccess() {
  play('toast.success', 120, (context, t0, out) => {
    tone(context, out, t0, { freq: 659.25, type: 'sine', attack: 0.006, decay: 0.14, peak: 0.09 }) // E5
    tone(context, out, t0 + 0.08, { freq: 830.61, type: 'sine', attack: 0.006, decay: 0.16, peak: 0.08 }) // G#5 (major third)
  })
}

function toastError() {
  play('toast.error', 200, (context, t0, out) => {
    const lp = context.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 400
    lp.connect(out)
    tone(context, lp, t0, { freq: 160, type: 'sawtooth', attack: 0.005, decay: 0.08, peak: 0.1 })
    tone(context, lp, t0 + 0.09, { freq: 160, type: 'sawtooth', attack: 0.005, decay: 0.09, peak: 0.1 })
  })
}

/** Soft tick previewed while dragging the volume slider (plays at the new volume). */
function previewTick() {
  play('preview.tick', 40, (context, t0, out) => {
    tone(context, out, t0, { freq: 880, type: 'sine', attack: 0.004, decay: 0.05, peak: 0.08 })
  })
}

// ── Existing notification-family sounds (character preserved) ──────────────

/** A cute two-note chime for an incoming notification (E6 → B6). */
export function playNotifySound() {
  playNotes('notify', 200, [
    { freq: 1318.5, at: 0 },
    { freq: 1975.5, at: 0.11 },
  ], { volume: 0.14, decay: 0.42 })
}

/** A short, warm ascending cue for joining a room or greeting a participant. */
export function playVoiceJoinSound() {
  playNotes('voice.join', 120, [
    { freq: 523.25, at: 0 },
    { freq: 659.25, at: 0.1 },
  ], { volume: 0.1, decay: 0.24, wave: 'sine' })
}

/** The matching descending cue for leaving a room or a participant departing. */
export function playVoiceLeaveSound() {
  playNotes('voice.leave', 120, [
    { freq: 659.25, at: 0 },
    { freq: 523.25, at: 0.1 },
  ], { volume: 0.09, decay: 0.22, wave: 'sine' })
}

/** A gentle two-tone huddle invitation, repeated twice. */
export function playHuddleRingSound() {
  playNotes('huddle.ring', 300, [
    { freq: 659.25, at: 0 },
    { freq: 783.99, at: 0.14 },
    { freq: 659.25, at: 0.48 },
    { freq: 783.99, at: 0.62 },
  ], { volume: 0.1, decay: 0.28 })
}

/** The single sound engine — one namespaced object for all UI triggers. */
export const sound = {
  // splash / loading
  bassSwell,
  ringPing,
  shimmer,
  squack,
  whoosh,
  loginSuccess,
  // messaging
  messageSend,
  reactionAdd,
  messageReceived,
  // voice extras
  micMute,
  micUnmute,
  screenShareStart,
  screenShareStop,
  cameraOn,
  cameraOff,
  handRaise,
  // ui navigation
  modalOpen,
  modalClose,
  switcherOpen,
  modeSwitch,
  tabSwitch,
  // toasts
  toastSuccess,
  toastError,
  // settings preview
  previewTick,
  // notification family
  notify: playNotifySound,
  voiceJoin: playVoiceJoinSound,
  voiceLeave: playVoiceLeaveSound,
  huddleRing: playHuddleRingSound,
}
