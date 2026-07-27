# Phase 7 — Tasks (Linear-lite planner)

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
> Linear-lite task tracker: projects, identifiers, workflow-state types, fracIndex ordering, GitHub sync.

Native issue tracker: Linear's model scoped down. Tasks are **server-authoritative
Postgres rows** (the polls pattern: REST mutations + WS fanout + notifications) — NOT a
Yjs doc kind, because the server must allocate identifiers, mutate state from GitHub
webhooks, run filtered queries, notify on assignment, and feed Sharpy. Realtime
collaboration is field-level LWW via `task.updated` events. All tasks are
workspace-visible in v1 (single workspace, every user a member); Notion-boards
(Phase 3.5) remain a separate freeform feature.

## Schema (migration `0023_tasks.sql`)

- `projects` — `key` (unique, `^[A-Z][A-Z0-9]{1,5}$`), `name`, `icon`, optional
  `channel_id` (default channel for chat cards), `next_number` (identifier sequence),
  `archived_at`. Identifier = `{key}-{number}`, allocated inside the insert transaction
  via `UPDATE projects SET next_number = next_number + 1 … RETURNING`.
- `task_states` — per-project workflow states: `name`, `color` (board palette key),
  `type` in `backlog|unstarted|started|completed|canceled` (automation targets type,
  never name), `position`. New projects are seeded Backlog/Todo/In Progress/In
  Review/Done/Canceled.
- `tasks` — `number` (unique per project), `title`, `description` (markdown), `state_id`,
  `priority` 0–4 (0 none, 1 urgent, 2 high, 3 medium, 4 low — Linear order),
  `assignee_id`, `creator_id`, `parent_id` (sub-tasks, one level deep like threads),
  `due_date`, `sort_order` (fracIndex within state column), `source_message_id`
  (create-from-message backlink), `completed_at` (stamped when the state's type is
  `completed`, cleared otherwise), soft `deleted_at`.
- `task_labels` (workspace-level, unique name + palette color) with
  `task_label_assignments` m2m.
- `task_comments` — markdown body, soft delete.
- `task_activity` — append-only feed: `actor_id` (NULL = automation), `kind`
  (`state|assignee|priority|labels|due|title|github_link|created`), `payload` jsonb
  `{from, to, …}`.
- `task_github_links` — `repo` (`owner/name`), `kind` `branch|pr|issue`, `ref`, `url`
  (unique per task), `title`, `state` (`open|draft|merged|closed`).
- `notifications` gains nullable `channel_id` + new `task_id` column; kind constraint
  extended with `task_assigned`, `task_comment`.

## Wire types

```
TaskState = { id, project_id, name, color, type, position }
Project   = { id, key, name, icon, channel_id?, created_by, archived_at?, created_at,
              states: TaskState[], open_count }
TaskGithubLink = { id, kind: 'branch'|'pr'|'issue', repo, ref, url, title, state, created_at }
Task      = { id, project_id, number, identifier, title, description, state_id,
              priority: 0|1|2|3|4, assignee_id?, creator_id, parent_id?, due_date?,
              sort_order, source_message_id?, created_at, updated_at, completed_at?,
              label_ids: string[], github_links: TaskGithubLink[], comment_count, sub_count }
TaskComment  = { id, task_id, author: MessageUser, body, created_at, updated_at?, deleted }
TaskActivity = { id: string, task_id, actor?: MessageUser, kind, payload, created_at }
TaskDetail   = Task & { comments: TaskComment[], activity: TaskActivity[], sub_tasks: Task[] }
TaskLabel    = { id, name, color }
```

`identifier` is precomputed server-side. Task ids are UUIDs; `number` is a plain JSON
number (small); `source_message_id` follows the string-bigint rule.

## REST (all `/api/v1`, any registered user unless noted)

| Method | Path | Notes |
|---|---|---|
| GET | `/projects` | all projects with states + open counts (archived included; client filters) |
| POST | `/projects` | `{key, name, icon?, channel_id?}` → `201 Project`; validates key, seeds states |
| PATCH | `/projects/{id}` | `{name?, icon?, channel_id?, archived?}`; key immutable |
| GET | `/projects/{id}/tasks?state_type=&assignee=&label=&priority=&q=` | non-deleted tasks |
| POST | `/projects/{id}/tasks` | `{title, description?, state_id?, priority?, assignee_id?, label_ids?, due_date?, parent_id?, source_message_id?}` → `201 Task`; parent must be top-level; default state = first `unstarted` |
| GET | `/tasks/{id}` | → `TaskDetail` |
| GET | `/tasks/by-key/{identifier}` | chip/deep-link resolution → `Task` |
| PATCH | `/tasks/{id}` | any mutable field (incl. `label_ids`, `sort_order`); writes activity, emits `task.updated`, notifies on assignee change |
| DELETE | `/tasks/{id}` | soft delete → 204 |
| POST | `/tasks/{id}/comments` | `{body}` → `201 TaskComment`; notifies task creator/assignee (not self) |
| PATCH | `/task-comments/{id}` | author only, `{body}` |
| DELETE | `/task-comments/{id}` | author only, soft → 204 |
| GET | `/me/tasks` | my open assigned tasks (state type not completed/canceled) |
| GET | `/tasks/search?q=&limit=` | identifier prefix + title ILIKE, for pickers |
| GET | `/task-labels` / POST / PATCH `/{id}` / DELETE `/{id}` | label CRUD (any user) |
| POST | `/integrations/github/webhook` | unauthenticated; HMAC `X-Hub-Signature-256` |

## WS events (main socket, broadcast to all registered users)

- `project.created` / `project.updated` `{project: Project}`
- `task.created` / `task.updated` `{task: Task}`
- `task.deleted` `{task_id, project_id}`
- `task.comment.created` / `task.comment.updated` / `task.comment.deleted`
  `{comment: TaskComment}` (deleted keeps ids, blanks body)

## Web

Fifth mode-rail entry **Tasks**: `/tasks` (My Issues + projects), `/t/:key` (project:
list/board toggle persisted per project), `/t/:key/:num` (project view + peek open).
`web/src/components/tasks/` — TasksHome, ProjectView, TaskListView (state-grouped dense
rows: priority icon, muted-mono identifier, title, label chips, due, assignee),
TaskBoardView (columns = states; drag via `useBoardDnd` + `fracIndex`), TaskPeek
(slide-over: editable title/description, property rail, GitHub links, sub-tasks,
comments + activity), PropertyPicker (keyboard-filterable), NewTaskModal (`c` in Tasks
mode), FilterBar. Store slices `projects`/`tasks`/`myTasks`; `task.*` WS handlers apply
in place; active project refetched on WS reconnect; drag writes `sort_order`
optimistically.

## GitHub sync (Phase C)

Env-first, inert when unset (Sharpy pattern): `GITHUB_WEBHOOK_SECRET`, plus optional
`GITHUB_REPOS` (`owner/name` comma allowlist). No PAT — sync is inbound-only, so there are
no outbound GitHub API calls. `server/src/routes/github.rs`.
Inbound (HMAC-verified, allowlisted): branch `create`/`push` with `key-123` in the branch
name upserts a `branch` link and moves `backlog|unstarted` tasks to the first
`started` state; `pull_request` opened/edited/ready links by branch name, PR title, or
magic words (`fix(es|ed)?|close[sd]?|resolve[sd]?\s+KEY-123`); merged PR moves to first
`completed` state; closed-unmerged only updates link state. Automation writes activity
with NULL actor; processing is idempotent (upsert by `(task_id, url)`; state moves no-op
at/past target type). Outbound v1 is client-only: **Copy branch name**
(`{key}-{number}-{slug}`, ≤60 chars).

## Chat bridging (Phase B)

Identifiers (`\b[A-Z][A-Z0-9]{1,5}-\d+\b`) in plain text, matched against known project
keys, auto-linkify to task chips; the explicit chip token is
`[[task:<identifier>|<title>]]` (identifier, not uuid — it's the stable public id and
the deep link derives from it). A composer `[[` picker Tasks section is deferred
(auto-linkify covers the flow). Message hover toolbar "Create task" opens the
project-pick + new-task modal prefilled from the message and sets
`source_message_id`; QuickSwitcher jumps to `KEY-123`. Notifications: `task_assigned`
(suppressed on self-assign) and `task_comment` (task creator/assignee, not the commenter)
ride the standard pipeline with push `path: /t/{key}/{number}`.

## Sharpy over tasks (Phase 7D)

Migration `0024_task_embeddings.sql`: one `task_embeddings` row per task —
`content` (identifier + title + state name + assignee + description + comments),
`content_hash`, dimension-less `embedding`. The 15s embed worker re-embeds when the
hash drifts (so state/assignee changes refresh retrieval); hard-deleting is handled by
FK cascade and soft-delete by an explicit embedding delete in `DELETE /tasks/{id}`.
Retrieval adds up to 6 task hits (workspace-visible, any registered caller);
`SharpySource` gains a `task` variant `{task_id, identifier, title, snippet}` whose
chip deep-links to `/t/{key}/{num}`.
