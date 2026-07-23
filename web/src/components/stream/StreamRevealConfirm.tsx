import { useStore } from '../../store'
import { Modal } from '../Modal'

/** Confirm lifting the streaming privacy shield for 10 minutes. */
export function StreamRevealConfirm({ onClose }: { onClose: () => void }) {
  const revealStreamContent = useStore((s) => s.revealStreamContent)

  return (
    <Modal title="Reveal private content?" onClose={onClose}>
      <p className="text-sm text-[var(--color-text-dim)]">
        This turns off streaming protection for 10 minutes. Private channels, direct
        messages, and message previews will be visible to anyone watching your screen.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-4 py-2 text-sm font-semibold text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            revealStreamContent()
            onClose()
          }}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
        >
          Reveal for 10 min
        </button>
      </div>
    </Modal>
  )
}
