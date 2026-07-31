// The Garden route: a private focus space.
//
// Three things happen here and nothing else:
//   1. Entering turns Do Not Disturb on and strips the app chrome (AppShell hides
//      the rail for this route), so the page is the garden.
//   2. An optional focus timer — a fixed-length countdown or an open-ended
//      stopwatch — rides the top edge as a deliberately thick progress bar.
//   3. You walk around.
//
// Leaving ends the session and restores DnD to whatever it was. That is stated in
// the UI rather than inferred, because it is the one non-obvious rule: a timer is
// tied to being in here, not to the account.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { KEYS, readLocal, readLocalBool, writeLocal, writeLocalBool } from '../../lib/localPrefs'
import { chordFor, formatChord, registerShortcut } from '../../lib/shortcuts'
import { sound } from '../../lib/sound'
import { fmtClockHours, fmtHoursMinutes } from '../../lib/util'
import { useStore } from '../../store'
import { Button, Card, CloseIcon, GearIcon, IconButton, Kbd, Modal } from '../../ui'
import { AvatarPicker } from './AvatarPicker'
import { GardenGame } from './GardenGame'

/** How often the readout re-renders. Half a second, so the seconds never stall. */
const TICK_MS = 500

/**
 * How long a session was, in prose. `fmtHoursMinutes` rounds to whole minutes,
 * which reads as "0m" for anything shorter than 30 seconds — reachable by calling
 * the API directly, so it is worth a sentence rather than a wrong label.
 */
function focusLength(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds))
  return safe < 60 ? `${safe}s` : fmtHoursMinutes(safe / 60)
}

function GardenMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 21V9" />
      <path d="M12 13c-4.7 0-7-2.3-7-7 4.7 0 7 2.3 7 7Z" />
      <path d="M12 16c4.7 0 7-2.3 7-7-4.7 0-7 2.3-7 7Z" />
    </svg>
  )
}

function TimerMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="13" r="8" />
      <path d="M12 13V9M9 2h6" />
    </svg>
  )
}

function MelodyMark({ on }: { on: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M9 18V5l10-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="16" cy="16" r="3" />
      {!on && <path d="m3 3 18 18" />}
    </svg>
  )
}

/**
 * The top edge. A countdown fills toward its end; a stopwatch sweeps, because
 * there is no end to fill toward and a fake fill would imply one.
 */
function FocusBar({
  mode,
  progress,
}: {
  mode: 'countdown' | 'stopwatch'
  progress: number
}) {
  const percent = Math.max(0, Math.min(1, progress)) * 100
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-(--z-slideover) h-3 overflow-hidden bg-black/45"
      role="progressbar"
      aria-label={mode === 'countdown' ? 'Focus countdown' : 'Focus stopwatch'}
      aria-valuemin={0}
      aria-valuemax={mode === 'countdown' ? 100 : undefined}
      aria-valuenow={mode === 'countdown' ? Math.round(percent) : undefined}
    >
      {mode === 'countdown' ? (
        // `max()` so the first seconds still read as a started bar rather than as
        // an empty track — a zero-width fill looks like a broken timer.
        <div
          className="garden-bar-fill relative h-full"
          style={{ width: `max(0.75rem, ${percent}%)` }}
        >
          <span className="garden-bar-shimmer absolute inset-y-0 right-0 w-16" />
        </div>
      ) : (
        <div className="garden-bar-sweep h-full w-full" />
      )}
    </div>
  )
}

function TimerPicker({
  presets,
  onPick,
  onCountUp,
  onClose,
}: {
  presets: number[]
  onPick: (minutes: number) => void
  onCountUp: () => void
  onClose: () => void
}) {
  return (
    <Modal title="Focus timer" headerIcon={<TimerMark />} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2">
          {presets.map((minutes) => (
            <button
              key={minutes}
              type="button"
              onClick={() => onPick(minutes)}
              className="flex min-h-16 cursor-pointer flex-col items-center justify-center rounded-xl border border-border bg-panel-2 text-text transition-colors hover:border-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="text-xl font-semibold tabular-nums">{minutes}</span>
              <span className="text-2xs uppercase tracking-wider text-text-faint">min</span>
            </button>
          ))}
        </div>
        <Button variant="outline" className="justify-center" onClick={onCountUp}>
          Count up instead
        </Button>
        <p className="text-xs text-text-faint">
          Notifications stay paused while you are in the garden. Leaving ends the
          session, and the time you tracked is kept.
        </p>
      </div>
    </Modal>
  )
}

export function GardenView() {
  const navigate = useNavigate()
  const status = useStore((state) => state.garden.status)
  const session = useStore((state) => state.garden.session)
  const syncedAt = useStore((state) => state.garden.sessionSyncedAt)
  const presetMinutes = useStore((state) => state.garden.presetMinutes)
  const avatar = useStore((state) => state.garden.avatar)
  const avatars = useStore((state) => state.garden.avatars)
  const error = useStore((state) => state.garden.error)
  const loadGarden = useStore((state) => state.loadGarden)
  const startTimer = useStore((state) => state.startGardenTimer)
  const stopTimer = useStore((state) => state.stopGardenTimer)
  const setAvatar = useStore((state) => state.setGardenAvatar)
  const dnd = useStore((state) => state.dnd)
  const setDnd = useStore((state) => state.setDnd)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [finished, setFinished] = useState<{ seconds: number } | null>(null)
  const [, setTick] = useState(0)
  const [ambience, setAmbience] = useState(() => readLocal(KEYS.gardenAmbience) !== 'off')
  const [ambienceVolume, setAmbienceVolume] = useState(() => {
    const stored = readLocal(KEYS.gardenAmbienceVolume)
    const parsed = stored === null ? NaN : Number(stored)
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.34
  })
  const [ambiencePanel, setAmbiencePanel] = useState(false)
  const ambienceRef = useRef<HTMLAudioElement | null>(null)

  // --- Do Not Disturb + session lifecycle ---------------------------------
  //
  // Entering enables DnD and remembers whether it was already on, so leaving
  // restores the user's own setting rather than switching it off for them.
  const dndBeforeRef = useRef<boolean | null>(null)
  const stopRef = useRef(stopTimer)
  stopRef.current = stopTimer
  const setDndRef = useRef(setDnd)
  setDndRef.current = setDnd
  // StrictMode mounts, unmounts and remounts every effect in development. The
  // exit path here is destructive (it ends a running session), so the cleanup
  // defers by a tick and only fires if nothing re-mounted in the meantime.
  const mountRef = useRef(0)

  useEffect(() => {
    mountRef.current += 1
    const generation = mountRef.current
    if (dndBeforeRef.current === null) dndBeforeRef.current = useStore.getState().dnd
    void loadGarden()
    if (!useStore.getState().dnd) void setDndRef.current(true)
    return () => {
      window.setTimeout(() => {
        if (mountRef.current !== generation) return
        ambienceRef.current?.pause()
        void stopRef.current()
        if (dndBeforeRef.current === false) void setDndRef.current(false)
        dndBeforeRef.current = null
      }, 0)
    }
  }, [loadGarden])

  // --- The clock -----------------------------------------------------------
  //
  // Elapsed time is the server's count plus the monotonic delta since it arrived.
  // `performance.now()` rather than `Date.now()`: a clock the user drags, or a
  // resumed suspend, must not rewrite how long they have been sitting here.
  const elapsed = session
    ? session.elapsed_secs + Math.max(0, (performance.now() - syncedAt) / 1000)
    : 0
  const total = session?.duration_secs ?? null
  const remaining = total === null ? null : Math.max(0, total - elapsed)

  useEffect(() => {
    if (!session) return
    const handle = window.setInterval(() => setTick((value) => value + 1), TICK_MS)
    return () => window.clearInterval(handle)
  }, [session])

  const doneRef = useRef(false)
  useEffect(() => {
    if (!session || session.mode !== 'countdown' || total === null) {
      doneRef.current = false
      return
    }
    if (remaining !== null && remaining > 0) return
    // Guarded: the tick that crosses zero can fire again before the store clears.
    if (doneRef.current) return
    doneRef.current = true
    sound.garden.timerDone()
    setFinished({ seconds: total })
    void stopTimer()
  }, [session, remaining, total, stopTimer])

  // --- Ambience ------------------------------------------------------------
  function ensureAmbience() {
    if (!ambienceRef.current) {
      const loop = new Audio('/assets/garden/audio/dark-shrine-loop.ogg')
      loop.loop = true
      loop.preload = 'auto'
      ambienceRef.current = loop
    }
    ambienceRef.current.volume = ambienceVolume
    return ambienceRef.current
  }

  useEffect(() => {
    if (ambienceRef.current) ambienceRef.current.volume = ambienceVolume
    writeLocal(KEYS.gardenAmbienceVolume, String(ambienceVolume))
  }, [ambienceVolume])

  // Autoplay needs a gesture, so the loop starts on the first interaction rather
  // than on arrival — a silent garden is better than a blocked-audio warning.
  useEffect(() => {
    if (!ambience) return
    const start = () => {
      void ensureAmbience().play().catch(() => {})
      window.removeEventListener('pointerdown', start)
      window.removeEventListener('keydown', start)
    }
    window.addEventListener('pointerdown', start)
    window.addEventListener('keydown', start)
    return () => {
      window.removeEventListener('pointerdown', start)
      window.removeEventListener('keydown', start)
    }
    // Only re-armed when the toggle changes: the ticking readout re-renders twice
    // a second, and re-registering these listeners that often is pure waste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ambience])

  function toggleAmbience() {
    const next = !ambience
    setAmbience(next)
    writeLocal(KEYS.gardenAmbience, next ? 'on' : 'off')
    if (next) void ensureAmbience().play().catch(() => {})
    else ambienceRef.current?.pause()
  }

  // --- Actions -------------------------------------------------------------
  const leave = useCallback(() => {
    // The session and DnD are unwound by the unmount effect, so leaving is one
    // navigation and cannot get out of step with a back button.
    navigate('/')
  }, [navigate])

  function pick(minutes: number) {
    setPickerOpen(false)
    setFinished(null)
    sound.garden.timerStart()
    void startTimer('countdown', minutes * 60)
  }

  function countUp() {
    setPickerOpen(false)
    setFinished(null)
    sound.garden.timerStart()
    void startTimer('stopwatch')
  }

  function endSession() {
    sound.garden.interact()
    void stopTimer()
  }

  const overlayOpen = pickerOpen || avatarOpen || finished !== null || ambiencePanel

  useEffect(() => {
    const off = [
      registerShortcut('garden.leave', (event) => {
        // A modal that traps the user owns Escape first.
        if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return
        event.preventDefault()
        if (ambiencePanel) {
          setAmbiencePanel(false)
          return
        }
        leave()
      }),
      registerShortcut('garden.timer', (event) => {
        if (overlayOpen) return
        event.preventDefault()
        sound.garden.interact()
        setPickerOpen(true)
      }),
    ]
    return () => off.forEach((unregister) => unregister())
  })

  // Offer the character picker once per device to anyone who has never chosen.
  // Non-blocking: skipping keeps the deterministic fallback, which already looks
  // like a real character. `status` gates it because `avatar` is null both before
  // the load and for someone who never picked — conflating the two popped the
  // picker at people who already had one.
  useEffect(() => {
    if (status !== 'ready' || avatar !== null) return
    if (readLocalBool(KEYS.gardenAvatarPrompted, false)) return
    setAvatarOpen(true)
  }, [status, avatar])

  if (status === 'error') {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-bg p-6">
        <div className="max-w-sm rounded-xl border border-border bg-panel p-5 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent-hover">
            <GardenMark />
          </div>
          <h1 className="text-lg font-semibold text-text">The garden is resting</h1>
          <p className="mt-1 text-sm text-text-dim">{error}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="outline" onClick={leave}>Back</Button>
            <Button onClick={() => void loadGarden()}>Try again</Button>
          </div>
        </div>
      </main>
    )
  }

  const readout = session
    ? fmtClockHours(remaining === null ? elapsed : remaining)
    : null

  return (
    <main className="relative min-h-0 flex-1 overflow-hidden bg-ink">
      <GardenGame frozen={overlayOpen} />

      {session && (
        <FocusBar
          mode={session.mode}
          progress={total === null || total === 0 ? 0 : elapsed / total}
        />
      )}

      <header className="pointer-events-none absolute inset-x-0 top-0 z-(--z-dropdown) flex items-start justify-between gap-3 p-3 pt-5 sm:p-4 sm:pt-6">
        <Card padding="sm" className="pointer-events-auto flex min-w-0 items-center gap-3 shadow-xl">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-ink">
            <GardenMark size={18} />
          </span>
          <div className="min-w-0">
            {session ? (
              <>
                <p className="text-lg font-semibold leading-none tabular-nums text-text">
                  {readout}
                </p>
                <p className="mt-1 truncate text-2xs text-text-faint">
                  {session.mode === 'countdown'
                    ? `left of ${focusLength(total ?? 0)} · notifications paused`
                    : 'tracked · notifications paused'}
                </p>
              </>
            ) : (
              <>
                <h1 className="text-sm font-semibold leading-none text-text">Garden</h1>
                <p className="mt-1 truncate text-2xs text-text-faint">
                  Notifications paused{dnd && dndBeforeRef.current ? '' : ' while you are here'}
                </p>
              </>
            )}
          </div>
        </Card>
        <Card padding="none" className="pointer-events-auto flex items-center gap-1 p-1.5 shadow-xl">
          <IconButton
            label={ambience ? 'Ambience settings' : 'Turn ambience on'}
            shape="circle"
            onClick={() => {
              sound.garden.interact()
              if (ambience) setAmbiencePanel((open) => !open)
              else toggleAmbience()
            }}
          >
            <MelodyMark on={ambience} />
          </IconButton>
          <IconButton
            label="Change your character"
            shape="circle"
            onClick={() => {
              sound.garden.interact()
              setAvatarOpen(true)
            }}
          >
            <GearIcon />
          </IconButton>
          <IconButton label="Leave the garden" shape="circle" onClick={leave}>
            <CloseIcon />
          </IconButton>
        </Card>
      </header>

      {ambiencePanel && (
        <aside className="absolute right-4 top-24 z-(--z-dropdown) w-[min(18rem,calc(100%-2rem))] rounded-xl border border-border bg-panel p-3 shadow-2xl">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-text">Ambience</p>
            <Button size="sm" variant="ghost" onClick={toggleAmbience}>
              Turn off
            </Button>
          </div>
          <label className="mt-3 flex items-center gap-3 text-xs text-text-dim">
            <span>Volume</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={ambienceVolume}
              onChange={(event) => setAmbienceVolume(Number(event.target.value))}
              className="min-h-10 flex-1 accent-[var(--color-accent)]"
            />
            <span className="w-8 text-right tabular-nums">
              {Math.round(ambienceVolume * 100)}
            </span>
          </label>
        </aside>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-(--z-dropdown) flex justify-center px-4">
        {session ? (
          <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-xl border border-border bg-panel p-2 pl-4 shadow-2xl">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-text">
                {session.mode === 'countdown' ? 'Focus session' : 'Tracking time'}
              </p>
              <p className="truncate text-xs text-text-faint">
                Leaving ends it · <Kbd>{formatChord(chordFor('garden.leave'))}</Kbd>
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={endSession}>
              End
            </Button>
          </div>
        ) : (
          <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-xl border border-border bg-panel p-2 pl-4 shadow-2xl">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-text">
                Start a timer, or just wander
              </p>
              <p className="truncate text-xs text-text-faint">
                <Kbd>{formatChord(chordFor('garden.timer'))}</Kbd> timer ·{' '}
                <Kbd>Space</Kbd> jump · <Kbd>{formatChord(chordFor('garden.leave'))}</Kbd> leave
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => {
                sound.garden.interact()
                setPickerOpen(true)
              }}
            >
              Focus timer
            </Button>
          </div>
        )}
      </div>

      {pickerOpen && (
        <TimerPicker
          presets={presetMinutes.length > 0 ? presetMinutes : [10, 20, 30, 45, 60, 120]}
          onPick={pick}
          onCountUp={countUp}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {finished && (
        <Modal
          title="Time is up"
          headerIcon={<TimerMark />}
          onClose={() => setFinished(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setFinished(null)}>
                Stay a while
              </Button>
              <Button onClick={leave}>Leave the garden</Button>
            </>
          }
        >
          <p className="text-sm text-text-dim">
            {focusLength(finished.seconds)} of focus. Notifications resume when you leave.
          </p>
        </Modal>
      )}

      {avatarOpen && (
        <AvatarPicker
          value={avatar}
          allowed={avatars}
          onClose={() => {
            // Record the offer either way, so a skip is not re-asked next visit.
            writeLocalBool(KEYS.gardenAvatarPrompted, true)
            setAvatarOpen(false)
          }}
          onChoose={(next) => {
            writeLocalBool(KEYS.gardenAvatarPrompted, true)
            void setAvatar(next)
            setAvatarOpen(false)
          }}
        />
      )}
    </main>
  )
}
