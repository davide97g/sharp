// Canvas route (`/x/:docId`). The shell — loading, kind guard, title, trash, presence,
// permissions — is DocSurface; this file is only the tldraw body.
//
// Contract: docs/arch/03-canvas-board.md.

import { DocSurface } from '../docs/DocSurface'
import { CanvasEditorInner } from './CanvasEditorInner'

export function CanvasEditor() {
  return (
    <DocSurface kind="canvas">
      {({ docId, user, canEdit, onStatus, onPeers, banners, titleRow }) => (
        <>
          {/* Fixed header block, not scrollable: the canvas itself pans and zooms and
              must own the remaining height. */}
          <div className="shrink-0 px-4 pt-4 pb-3 sm:px-6">
            {banners}
            {titleRow()}
          </div>
          <CanvasEditorInner
            key={docId}
            docId={docId}
            user={user}
            editable={canEdit}
            onStatus={onStatus}
            onPeers={onPeers}
          />
        </>
      )}
    </DocSurface>
  )
}
