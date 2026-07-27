// "You are sharing your screen" — window-scale feedback for the sharer.
//
// Sharing is the one call state with a real cost to forgetting: the call panel can be
// minimized, in picture-in-picture, or behind a docs tab while your screen keeps going
// out. So the sharer gets two things that follow them everywhere, independent of stage
// mode: a breathing frame around the viewport, and one pill that both names the state
// and stops it. Viewers need neither — they can see the shared screen.
//
// The pill is the only stop control that is always one click away; the call bar's
// share button keeps working and stays in sync (both read `voice.screenStatus`).
//
// Mounted by VideoStage in every stage mode. Hidden in `full`, where the stage already
// fills the screen and labels the share on the tile itself.

import { createPortal } from 'react-dom'
import { useStore } from '../../store'

export function ScreenShareBeacon() {
  const screenStatus = useStore((s) => s.voice.screenStatus)
  const stageMode = useStore((s) => s.voice.stageMode)
  const toggleVoiceScreen = useStore((s) => s.toggleVoiceScreen)

  if (screenStatus === 'off') return null
  const starting = screenStatus === 'starting'

  return createPortal(
    <>
      {stageMode === 'full' ? null : (
        <div
          aria-hidden
          className={`share-frame pointer-events-none fixed inset-0 z-(--z-floating) rounded-xl ${
            starting ? 'opacity-40' : ''
          }`}
        />
      )}
      <div
        className="pointer-events-none fixed inset-x-0 z-(--z-floating) flex justify-center px-3"
        style={{ top: 'max(0.75rem, var(--safe-top))' }}
      >
        <div
          role="status"
          className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-share bg-share-soft py-1.5 pl-3 pr-1.5 text-share-fg shadow-2xl backdrop-blur-md"
        >
          <span className="share-live-dot h-2 w-2 shrink-0 rounded-full" aria-hidden />
          <span className="text-xs font-semibold">
            {starting ? 'Starting your screen share…' : 'You’re sharing your screen'}
          </span>
          <button
            type="button"
            disabled={starting}
            onClick={() => void toggleVoiceScreen()}
            className="cursor-pointer rounded-full bg-danger px-2.5 py-1 text-2xs font-semibold text-white outline-none transition-colors hover:bg-danger-hover focus-visible:ring-2 focus-visible:ring-danger-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            Stop sharing
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
