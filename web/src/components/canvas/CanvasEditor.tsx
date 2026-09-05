// Canvas route (`/x/:docId`). The shell — loading, kind guard, title, trash, presence,
// permissions — is DocSurface; this file is only the Excalidraw body plus the two
// presentation modes layered on top of it.
//
// Contract: docs/arch/03-canvas-board.md.
//
// **Full screen** and **read-only** are deliberately independent:
//
//   - Full screen is about chrome. The stage becomes a `fixed inset-0` overlay at the
//     lightbox band, which covers the app rail, the DocSurface header and the title row,
//     and the same element is handed to the native Fullscreen API so the *browser* chrome
//     goes too. The API call is best-effort — if it is refused (no user gesture, an iframe
//     without the permission), the in-page overlay alone still gives a chrome-free canvas.
//   - Read-only is about intent: an editor asking not to edit, so a demo cannot be
//     scribbled on by a stray click. It is per-tab and never persisted, and it stacks
//     under the role gate rather than over it — a viewer cannot toggle *out* of it.
//
// The stage element must keep its identity across the toggle. Moving `<CanvasEditorInner>`
// into a different subtree would unmount it, which tears down the Y.Doc and the sync
// socket; only the wrapper's className changes here.

import { useCallback, useEffect, useRef, useState } from 'react'
import { registerShortcut, chordFor, formatChord } from '../../lib/shortcuts'
import { DocSurface } from '../docs/DocSurface'
import { CanvasEditorInner } from './CanvasEditorInner'
import {
  CheckIcon,
  ExpandIcon,
  EyeIcon,
  IconButton,
  Kbd,
  MenuItem,
  PencilIcon,
  ShrinkIcon,
} from '../../ui'

/** How long the floating controls stay up after the last pointer or key activity. */
const CONTROLS_IDLE_MS = 2500

export function CanvasEditor() {
  const [fullscreen, setFullscreen] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [idle, setIdle] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)

  const exit = useCallback(() => setFullscreen(false), [])

  // Enter/leave the native Fullscreen API alongside the overlay. Requested on the stage
  // itself rather than <html> so Excalidraw's own portals — which mount inside its
  // container — stay inside the fullscreen element and remain visible.
  useEffect(() => {
    if (!fullscreen) return
    const el = stageRef.current
    if (el && !document.fullscreenElement) void el.requestFullscreen?.().catch(() => {})
    return () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [fullscreen])

  // F11 or the browser's own Escape leaves fullscreen without telling React.
  useEffect(() => {
    if (!fullscreen) return
    function onChange() {
      if (!document.fullscreenElement) setFullscreen(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [fullscreen])

  // Escape also has to work in the fallback case, where the native request was refused
  // and the browser therefore has no fullscreen of its own to leave.
  useEffect(() => {
    if (!fullscreen) return
    return registerShortcut('canvas.exitFullscreen', (e) => {
      e.preventDefault()
      setFullscreen(false)
    })
  }, [fullscreen])

  useEffect(() => registerShortcut('canvas.fullscreen', (e) => {
    e.preventDefault()
    setFullscreen((f) => !f)
  }), [])

  useEffect(() => registerShortcut('canvas.readOnly', (e) => {
    e.preventDefault()
    setReadOnly((r) => !r)
  }), [])

  // Fade the controls out while the viewer is still, so a presented canvas is just the
  // canvas. Any movement brings them back.
  useEffect(() => {
    if (!fullscreen) {
      setIdle(false)
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const wake = () => {
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), CONTROLS_IDLE_MS)
    }
    wake()
    window.addEventListener('pointermove', wake)
    window.addEventListener('keydown', wake)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [fullscreen])

  return (
    <DocSurface
      kind="canvas"
      menuExtras={({ canEdit, close }) => (
        <>
          <MenuItem
            icon={<ExpandIcon />}
            trailing={<Kbd>{formatChord(chordFor('canvas.fullscreen'))}</Kbd>}
            onClick={() => {
              close()
              setFullscreen(true)
            }}
          >
            Full screen
          </MenuItem>
          {/* A viewer is already read-only; offering the toggle would imply it can be
              turned off. */}
          {canEdit && (
            <MenuItem
              icon={readOnly ? <CheckIcon /> : <EyeIcon />}
              trailing={<Kbd>{formatChord(chordFor('canvas.readOnly'))}</Kbd>}
              onClick={() => {
                close()
                setReadOnly((r) => !r)
              }}
            >
              Read-only view
            </MenuItem>
          )}
        </>
      )}
    >
      {({ docId, user, canEdit, onStatus, onPeers, banners, titleRow }) => (
        <>
          {/* Fixed header block, not scrollable: the canvas itself pans and zooms and
              must own the remaining height. Hidden, not unmounted, in full screen — the
              title textarea keeps its debounced patch state either way. */}
          <div className={fullscreen ? 'hidden' : 'shrink-0 px-4 pt-4 pb-3 sm:px-6'}>
            {banners}
            {titleRow()}
          </div>
          <div
            ref={stageRef}
            className={
              fullscreen
                ? 'fixed inset-0 z-(--z-lightbox) flex bg-ink'
                : 'flex min-h-0 flex-1'
            }
          >
            <CanvasEditorInner
              key={docId}
              docId={docId}
              user={user}
              editable={canEdit}
              viewOnly={readOnly}
              onStatus={onStatus}
              onPeers={onPeers}
            />
            {fullscreen && (
              <StageControls
                idle={idle}
                canEdit={canEdit}
                readOnly={readOnly}
                onToggleReadOnly={() => setReadOnly((r) => !r)}
                onExit={exit}
              />
            )}
          </div>
        </>
      )}
    </DocSurface>
  )
}

/**
 * The only chrome full screen keeps. Bottom-centred because Excalidraw already owns the
 * three corners it uses — menu top-left, library top-right, zoom bottom-left.
 */
function StageControls({
  idle,
  canEdit,
  readOnly,
  onToggleReadOnly,
  onExit,
}: {
  idle: boolean
  canEdit: boolean
  readOnly: boolean
  onToggleReadOnly: () => void
  onExit: () => void
}) {
  return (
    <div
      // The band matters: Excalidraw's own UI wrapper is a positioned layer inside this
      // same stacking context, so a z-index of `auto` leaves the pill painted underneath
      // it — present in the DOM, invisible on screen.
      className={`absolute bottom-4 left-1/2 z-(--z-lightbox) flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-panel/90 p-1 shadow-2xl backdrop-blur transition-opacity duration-300 ${
        idle ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
    >
      {/* A viewer has no edit mode to return to, so the toggle would be a dead switch. */}
      {canEdit && (
        <IconButton
          shape="circle"
          label={readOnly ? 'Resume editing' : 'Read-only view'}
          variant={readOnly ? 'accent' : 'ghost'}
          onClick={onToggleReadOnly}
        >
          {readOnly ? <PencilIcon /> : <EyeIcon />}
        </IconButton>
      )}
      <IconButton shape="circle" label="Leave full screen" onClick={onExit}>
        <ShrinkIcon />
      </IconButton>
    </div>
  )
}
