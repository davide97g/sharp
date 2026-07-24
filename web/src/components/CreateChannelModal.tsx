import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from './Modal'
import { Button, ChoiceCard, Field, Input } from '../ui'
import { useStore } from '../store'
import { toastError } from '../lib/toast'

const NAME_RE = /^[a-z0-9-]{1,50}$/

export function CreateChannelModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [kind, setKind] = useState<'public' | 'private'>('public')
  const [busy, setBusy] = useState(false)
  const createChannel = useStore((s) => s.createChannel)
  const navigate = useNavigate()

  const normalized = name.trim().toLowerCase()
  const valid = NAME_RE.test(normalized)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    try {
      const ch = await createChannel({ name: normalized, kind, topic: topic.trim() || undefined })
      onClose()
      navigate(`/c/${ch.id}`)
    } catch (err) {
      if (err instanceof Error) toastError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Create a channel" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" hint="Lowercase letters, numbers, and hyphens. 1–50 chars.">
          <Input
            autoFocus
            prefix="#"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="marketing"
          />
        </Field>

        <Field label="Topic (optional)">
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What's this channel about?"
          />
        </Field>

        <div className="flex gap-2">
          <ChoiceCard
            selected={kind === 'public'}
            onSelect={() => setKind('public')}
            title="Public"
            description="Anyone can join"
            selectedStyle="fill"
            className="flex-1"
          />
          <ChoiceCard
            selected={kind === 'private'}
            onSelect={() => setKind('private')}
            title="Private"
            description="Invite only"
            selectedStyle="fill"
            className="flex-1"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="px-4" disabled={!valid || busy}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  )
}
