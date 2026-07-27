// Per-project GitHub repository links: the status pill shown on the Tasks home
// project cards and in the project header, plus the manage modal behind it
// (connect a repo, install/inspect the webhook, set the branch convention).
//
// Status wording maps 1:1 to the server's link row — see docs/arch/11-tasks.md:
//   hook_active      a signed delivery has arrived → Connected
//   hook_installed   we created the webhook with a PAT (vs. pasted by hand)
//   last_error       last outbound failure, already phrased for display
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { toastError, toastInfo } from '../../lib/toast'
import { fmtRelative } from '../../lib/util'
import type { Project, ProjectGithubRepo, ProjectGithubSetup } from '../../lib/types'
import { useStore } from '../../store'
import { Modal } from '../Modal'
import { BRANCH_TOKENS, branchTemplateExample, DEFAULT_BRANCH_TEMPLATE } from './taskUi'
import {
  Badge,
  Banner,
  Button,
  Card,
  CopyIcon,
  ExternalLinkIcon,
  Field,
  GithubIcon,
  IconButton,
  Input,
  SectionLabel,
  Spinner,
  TrashIcon,
  WarningIcon,
  type BadgeTone,
} from '../../ui'

/** Token page pre-filled with the scopes a full-service link needs. */
const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo,admin:repo_hook&description=sharp%20task%20sync'

type Status = { tone: BadgeTone; label: string; detail: string }

/** One repo's headline status. Order matters: errors outrank "connected". */
export function statusOf(repo: ProjectGithubRepo): Status {
  const seen = repo.last_event_at ? `last event ${fmtRelative(repo.last_event_at)} ago` : ''
  if (repo.last_error) return { tone: 'danger', label: 'Action needed', detail: repo.last_error }
  if (repo.hook_active) return { tone: 'success', label: 'Connected', detail: seen }
  if (repo.hook_installed)
    return { tone: 'warning', label: 'Webhook installed', detail: 'waiting for the first event' }
  return { tone: 'warning', label: 'Finish setup', detail: 'add the webhook in GitHub' }
}

function copy(value: string, what: string) {
  void navigator.clipboard.writeText(value)
  toastInfo(`${what} copied`)
}

/**
 * The affordance that lives on a project card / header: a status pill when a repo
 * is linked, the connect CTA when none is. Opens the manage modal.
 */
export function ProjectGithubButton({
  project,
  compact,
}: {
  project: Project
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const repo = project.github_repos[0]
  const extra = project.github_repos.length - 1
  const status = repo ? statusOf(repo) : null

  return (
    <>
      <button
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
        title={
          repo
            ? `${repo.repo} — ${status?.label}${status?.detail ? ` (${status.detail})` : ''}`
            : 'Link a GitHub repository'
        }
        className={
          repo
            ? 'flex min-h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-2xs text-text-dim transition-colors hover:border-accent hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
            : 'flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-2xs text-text-faint transition-colors hover:border-accent hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
        }
      >
        <GithubIcon size={12} />
        {repo ? (
          <>
            <span className="min-w-0 truncate font-mono">{compact ? repo.repo.split('/')[1] : repo.repo}</span>
            {extra > 0 && <span className="text-text-faint">+{extra}</span>}
            <StatusDot tone={status!.tone} />
          </>
        ) : (
          <span>Add GitHub repository</span>
        )}
      </button>
      {open && <ProjectGithubModal project={project} onClose={() => setOpen(false)} />}
    </>
  )
}

function StatusDot({ tone }: { tone: BadgeTone }) {
  const color =
    tone === 'success' ? 'bg-success-fg' : tone === 'danger' ? 'bg-danger-fg' : 'bg-warning-fg'
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} aria-hidden />
}

export function ProjectGithubModal({
  project,
  onClose,
}: {
  project: Project
  onClose: () => void
}) {
  const [setup, setSetup] = useState<ProjectGithubSetup | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    api.tasks
      .github(project.id)
      .then(setSetup)
      .catch((e) => {
        if (e instanceof Error) toastError(e.message)
        onClose()
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  // Every mutation answers with the same payload, so one helper covers them all.
  async function run(action: () => Promise<ProjectGithubSetup>) {
    setBusy(true)
    try {
      setSetup(await action())
      setAdding(false)
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const repos = setup?.project.github_repos ?? project.github_repos

  return (
    <Modal title="GitHub" size="xl" headerIcon={<GithubIcon size={16} />} onClose={onClose}>
      {!setup ? (
        <div className="flex h-32 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-5">
          {repos.length > 0 && (
            <div className="space-y-3">
              {repos.map((repo) => (
                <RepoCard
                  key={repo.id}
                  repo={repo}
                  setup={setup}
                  busy={busy}
                  onVerify={() => run(() => api.tasks.verifyGithub(project.id, repo.id))}
                  onToken={(token) =>
                    run(() => api.tasks.updateGithub(project.id, repo.id, { token }))
                  }
                  onRotate={() =>
                    run(() => api.tasks.updateGithub(project.id, repo.id, { rotate_secret: true }))
                  }
                  onDisconnect={() => run(() => api.tasks.disconnectGithub(project.id, repo.id))}
                />
              ))}
            </div>
          )}

          {repos.length === 0 || adding ? (
            <ConnectForm
              busy={busy}
              first={repos.length === 0}
              onCancel={repos.length === 0 ? undefined : () => setAdding(false)}
              onConnect={(input) => run(() => api.tasks.connectGithub(project.id, input))}
            />
          ) : (
            <Button variant="ghost" size="sm" className="min-h-10" onClick={() => setAdding(true)}>
              + Link another repository
            </Button>
          )}

          <BranchConvention project={project} />

          <div className="rounded-lg border border-border-soft bg-panel-2 px-3 py-2.5 text-2xs text-text-faint">
            <p className="mb-1 font-semibold text-text-dim">What sync does</p>
            <p>
              A branch or PR whose name, title, or body contains a task identifier
              (<span className="font-mono">{project.key}-123</span>) links to that task and moves it
              to the first <span className="text-text-dim">started</span> state; merging the PR
              moves it to the first <span className="text-text-dim">completed</span> state. Closing
              a PR without merging only updates the link.
            </p>
          </div>
        </div>
      )}
    </Modal>
  )
}

function RepoCard({
  repo,
  setup,
  busy,
  onVerify,
  onToken,
  onRotate,
  onDisconnect,
}: {
  repo: ProjectGithubRepo
  setup: ProjectGithubSetup
  busy: boolean
  onVerify: () => void
  onToken: (token: string | null) => void
  onRotate: () => void
  onDisconnect: () => void
}) {
  const status = statusOf(repo)
  const [showManual, setShowManual] = useState(!repo.hook_installed && !repo.hook_active)
  const [token, setToken] = useState('')
  const secret = setup.secrets[repo.id] ?? ''

  return (
    <Card padding="md" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <GithubIcon size={14} />
        <a
          href={`https://github.com/${repo.repo}`}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-1 font-mono text-sm text-text hover:text-accent-hover"
        >
          <span className="truncate">{repo.repo}</span>
          <ExternalLinkIcon size={11} />
        </a>
        <Badge tone={status.tone}>{status.label}</Badge>
        {repo.visibility && <Badge tone="neutral">{repo.visibility}</Badge>}
        {repo.has_token && <Badge tone="neutral">token</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" className="min-h-9" disabled={busy} onClick={onVerify}>
            Re-check
          </Button>
          <IconButton label="Unlink repository" variant="danger" disabled={busy} onClick={onDisconnect}>
            <TrashIcon size={14} />
          </IconButton>
        </div>
      </div>

      <p className="text-2xs text-text-faint">
        {status.detail}
        {repo.default_branch && !repo.last_error && (
          <>
            {status.detail ? ' · ' : ''}default branch <span className="font-mono">{repo.default_branch}</span>
          </>
        )}
      </p>

      {repo.last_error && (
        <Banner tone="danger" icon={<WarningIcon size={14} />}>
          {repo.last_error}
        </Banner>
      )}

      {/* Token: absent → offer one; present → replace or drop back to manual. */}
      {repo.has_token ? (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-text-faint">
          <span>Sharp manages this webhook with a stored token.</span>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-9"
            disabled={busy}
            onClick={() => onToken(null)}
          >
            Remove token
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[min(100%,16rem)] flex-1">
            <Field
              label="Access token (optional)"
              hint={
                <>
                  Lets sharp install the webhook and read visibility for you.{' '}
                  <a href={TOKEN_URL} target="_blank" rel="noreferrer" className="text-accent-hover underline">
                    Create one
                  </a>{' '}
                  with <span className="font-mono">repo</span> +{' '}
                  <span className="font-mono">admin:repo_hook</span>.
                </>
              }
            >
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_…"
                className="min-h-10 font-mono"
              />
            </Field>
          </div>
          <Button
            size="sm"
            className="min-h-10"
            disabled={busy || !token.trim()}
            onClick={() => {
              onToken(token.trim())
              setToken('')
            }}
          >
            Save token
          </Button>
        </div>
      )}

      <button
        onClick={() => setShowManual((v) => !v)}
        className="cursor-pointer text-2xs text-text-faint underline decoration-dotted hover:text-text-dim"
      >
        {showManual ? 'Hide' : 'Show'} manual webhook setup
      </button>

      {showManual && (
        <div className="space-y-2 rounded-lg border border-border-soft bg-panel-2 p-3">
          <p className="text-2xs text-text-faint">
            In GitHub: <span className="font-mono">{repo.repo}</span> → Settings → Webhooks → Add
            webhook. Content type must be <span className="font-mono">application/json</span>.
          </p>
          <CopyRow label="Payload URL" value={setup.webhook_url} />
          <CopyRow label="Secret" value={secret} mono secretValue />
          <p className="text-2xs text-text-faint">
            Events: {setup.events.map((e) => e.replace('_', ' ')).join(', ')} — or just pick “Send
            me everything”.
          </p>
          <Button variant="ghost" size="sm" className="min-h-9" disabled={busy} onClick={onRotate}>
            Rotate secret
          </Button>
        </div>
      )}
    </Card>
  )
}

function CopyRow({
  label,
  value,
  mono,
  secretValue,
}: {
  label: string
  value: string
  mono?: boolean
  secretValue?: boolean
}) {
  const [revealed, setRevealed] = useState(!secretValue)
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-2xs text-text-faint">{label}</span>
      <code
        className={`min-w-0 flex-1 truncate rounded-md border border-border bg-ink px-2 py-1 text-2xs ${mono ? 'font-mono' : ''}`}
      >
        {revealed ? value || '—' : '•'.repeat(24)}
      </code>
      {secretValue && (
        <Button variant="ghost" size="sm" className="min-h-9" onClick={() => setRevealed((v) => !v)}>
          {revealed ? 'Hide' : 'Reveal'}
        </Button>
      )}
      <IconButton label={`Copy ${label.toLowerCase()}`} onClick={() => copy(value, label)}>
        <CopyIcon size={13} />
      </IconButton>
    </div>
  )
}

function ConnectForm({
  busy,
  first,
  onCancel,
  onConnect,
}: {
  busy: boolean
  first: boolean
  onCancel?: () => void
  onConnect: (input: { repo: string; token?: string }) => void
}) {
  const [repo, setRepo] = useState('')
  const [token, setToken] = useState('')

  return (
    <Card padding="md" className="space-y-3">
      {first && (
        <div>
          <SectionLabel as="h3" size="xs">
            Link a repository
          </SectionLabel>
          <p className="mt-1 text-2xs text-text-faint">
            Branches and pull requests then move tasks automatically. Private repos work the same
            way — the webhook is push-based.
          </p>
        </div>
      )}
      <Field label="Repository" hint="owner/name, or paste the GitHub URL">
        <Input
          autoFocus
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="fortitudex/sharp"
          className="min-h-11 font-mono"
        />
      </Field>
      <Field
        label="Access token (optional)"
        hint={
          <>
            With a token sharp verifies the repo and installs the webhook itself.{' '}
            <a href={TOKEN_URL} target="_blank" rel="noreferrer" className="text-accent-hover underline">
              Create one
            </a>{' '}
            with <span className="font-mono">repo</span> +{' '}
            <span className="font-mono">admin:repo_hook</span>. Without it you get manual setup
            instructions.
          </>
        }
      >
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ghp_…"
          className="min-h-11 font-mono"
        />
      </Field>
      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" size="sm" className="min-h-10" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          className="min-h-10"
          disabled={busy || !repo.trim()}
          onClick={() => onConnect({ repo: repo.trim(), token: token.trim() || undefined })}
        >
          {busy ? 'Connecting…' : 'Connect repository'}
        </Button>
      </div>
    </Card>
  )
}

function BranchConvention({ project }: { project: Project }) {
  const me = useStore((s) => s.me)
  const [template, setTemplate] = useState(project.branch_template || DEFAULT_BRANCH_TEMPLATE)
  const [busy, setBusy] = useState(false)
  const saved = project.branch_template || DEFAULT_BRANCH_TEMPLATE
  const preview = useMemo(
    () => branchTemplateExample(template, project.key, me?.display_name ?? 'me'),
    [template, project.key, me?.display_name],
  )

  async function save() {
    setBusy(true)
    try {
      // '' resets to the built-in default rather than storing a duplicate of it.
      const next = template.trim() === DEFAULT_BRANCH_TEMPLATE ? '' : template.trim()
      await api.tasks.updateProject(project.id, { branch_template: next })
      toastInfo('Branch convention saved')
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <SectionLabel as="h3" size="xs">
        Branch convention
      </SectionLabel>
      <Field
        label="Template"
        hint={`Tokens: ${BRANCH_TOKENS.map((t) => `{${t}}`).join(' ')} — must keep {identifier} (or {key} + {number}) so pushes link back to the task.`}
      >
        <Input
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          placeholder={DEFAULT_BRANCH_TEMPLATE}
          className="min-h-11 font-mono"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-ink px-2 py-1.5 font-mono text-2xs text-text-dim">
          {preview}
        </code>
        <IconButton label="Copy example branch name" onClick={() => copy(preview, 'Branch name')}>
          <CopyIcon size={13} />
        </IconButton>
        <Button
          size="sm"
          className="min-h-10"
          disabled={busy || template.trim() === saved}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
    </div>
  )
}
