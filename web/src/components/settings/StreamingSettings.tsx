// Settings → Streaming: the privacy shield used while screen sharing or on camera.
//
// Blurs private channels, reverts nicknames, and shows a banner. See the streaming
// predicates in lib/store/predicates.ts for what "shielded" resolves to.

import { useStore } from '../../store'
import { SectionLabel } from '../../ui'
import { Toggle } from '../Toggle'


export function StreamingSettings() {
  const streamManual = useStore((s) => s.streamManual)
  const setStreamManual = useStore((s) => s.setStreamManual)
  const revertNicknames = useStore((s) => s.streamRevertNicknames)
  const setStreamRevertNicknames = useStore((s) => s.setStreamRevertNicknames)

  return (
    <div className="flex flex-col gap-5">
      <SectionLabel size="xs">Privacy Shield</SectionLabel>
      <p className="-mt-2 text-2xs text-[var(--color-text-faint)]">
        While you share your screen, the Privacy Shield hides private channels, direct
        messages, previews, and your email from everyone watching. It arms automatically
        during in-app screen shares; turn it on manually when streaming with external
        software (OBS, etc.).
      </p>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] px-3 py-2">
        <div>
          <div className="text-sm font-medium text-[var(--color-text)]">Streaming mode (manual)</div>
          <div className="text-2xs text-[var(--color-text-faint)]">
            Keep the Privacy Shield armed even without an in-app screen share.
          </div>
        </div>
        <Toggle checked={streamManual} onChange={setStreamManual} label="Streaming mode (manual)" />
      </div>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] px-3 py-2">
        <div>
          <div className="text-sm font-medium text-[var(--color-text)]">
            Show plain names while streaming
          </div>
          <div className="text-2xs text-[var(--color-text-faint)]">
            Hide your personal nicknames and show real display names the whole time
            you&apos;re streaming — even while revealed content is visible.
          </div>
        </div>
        <Toggle
          checked={revertNicknames}
          onChange={setStreamRevertNicknames}
          label="Show plain names while streaming"
        />
      </div>
      <p className="text-2xs text-[var(--color-text-faint)]">
        Saved on this device. From a hidden conversation you can pause the shield for
        10 minutes — for just that conversation, or for everything.
      </p>
    </div>
  )
}
