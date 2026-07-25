// Board route (`/b/:docId`). The shell — loading, kind guard, title, trash, presence,
// permissions — is DocSurface; this file is only the kanban body plus the one menu item
// that is board-specific.
//
// Contract: docs/arch/03-canvas-board.md.

import { useState } from 'react'
import { MenuItem } from '../../ui'
import { DocSurface } from '../docs/DocSurface'
import { BoardEditorInner } from './BoardEditorInner'

export function BoardEditor() {
  // Owned here rather than in the shell: the customize dialog belongs to the board body,
  // which is what knows about columns and card properties.
  const [showCustomize, setShowCustomize] = useState(false)

  return (
    <DocSurface
      kind="board"
      menuExtras={({ canEdit, close }) =>
        canEdit ? (
          <MenuItem
            onClick={() => {
              close()
              setShowCustomize(true)
            }}
          >
            Customize properties…
          </MenuItem>
        ) : null
      }
    >
      {({ doc, docId, user, canEdit, onStatus, onPeers, banners, titleRow }) => (
        <>
          {/* Fixed header block, not scrollable: the board owns the remaining height and
              scrolls its columns horizontally. */}
          <div className="shrink-0 px-4 pt-4 pb-3 sm:px-6">
            {banners}
            {titleRow()}
          </div>
          <BoardEditorInner
            key={docId}
            docId={docId}
            channelId={doc.channel_id}
            user={user}
            editable={canEdit}
            customizeOpen={showCustomize}
            onCustomizeClose={() => setShowCustomize(false)}
            onStatus={onStatus}
            onPeers={onPeers}
          />
        </>
      )}
    </DocSurface>
  )
}
