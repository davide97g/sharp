# Phase 7 plan — Tasks (Linear-lite planner)

Internal issue tracker for sharp: Linear's data model and UX, scoped down, built native.
Tasks are chat-bridged (create from a message, `SHARP-123` chips) and sync with GitHub
(branch/PR linking + state automation). This document is the implementation plan; when
built, the contract moves into `docs/ARCHITECTURE.md` as "Phase 7 — Tasks".

## Core architectural decision

**Tasks are server-authoritative Postgres rows — NOT a fourth Yjs doc kind.**

Boards (Phase 3.5) are deliberately opaque to the server: raw Yjs bytes, no
`content_text`, no server interpretation. That is exactly wrong for a tracker, where the
server must:

- allocate global identifiers (`SHARP-123`) from a sequence,
- mutate state from GitHub webhooks (no client online),
- answer queries ("my open issues", filters) in SQL,
- notify on assignment and fan out `task.*` WS events,
- feed Sharpy embeddings with readable content.

The pattern to copy is **polls** (`server/src/routes/polls.rs`): durable rows + REST
mutations + WS fanout + chat bridging + notification kinds. Realtime collaboration on a
task is field-level (LWW via `task.updated` events), which is all a tracker needs — no
CRDT. The existing Notion-style boards stay as-is (freeform); this is a separate feature
with its own mode.

What we steal from Linear:

- **Data model**: teams→projects→issues simplified to projects→tasks; workflow states
  with *types* (`backlog|unstarted|started|completed|canceled`) so automation targets
  type, never name; priority enum 0–4; labels; one-level sub-issues (mirrors sharp's
  thread rule).
- **UX**: list view grouped by state with dense rows (priority icon, identifier, title,
  labels, assignee, due), board view, side "peek" panel, keyboard-first (`c` to create),
  property pickers with keyboard filter.
- **GitHub flow**: copy-branch-name button, identifier-in-branch-name convention, magic
  words (`fixes SHARP-123`), PR-driven state automation.

What we skip (v1): cycles/sprints, estimates, roadmaps, custom workflow engines, issue
relations beyond parent/sub, project-level ACL (all tasks are workspace-visible — sharp
is single-workspace and every user is a member; private projects are a later add).

## Schema — migration `0023_tasks.sql`

```sql
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,                    -- 'SHARP', 'WEB': 2-6 chars A-Z0-9, starts with letter
  name text NOT NULL,
  icon text NOT NULL DEFAULT '',
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,  -- default channel for chat cards
  next_number bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL,                         -- boardColors palette key, not hex
  type text NOT NULL CHECK (type IN ('backlog','unstarted','started','completed','canceled')),
  position int NOT NULL
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number bigint NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',        -- markdown, rendered with the chat renderer
  state_id uuid NOT NULL REFERENCES task_states(id),
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
                                               -- 0 none, 1 urgent, 2 high, 3 medium, 4 low (Linear order)
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  creator_id uuid NOT NULL REFERENCES users(id),
  parent_id uuid REFERENCES tasks(id) ON DELETE SET NULL,     -- one level deep, like threads
  due_date date,
  sort_order text NOT NULL,                    -- fracIndex within state column
  source_message_id bigint REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (project_id, number)
);

CREATE TABLE task_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  color text NOT NULL                          -- palette key
);
CREATE TABLE task_label_assignments (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

CREATE TABLE task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,                          -- markdown
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  deleted_at timestamptz
);

CREATE TABLE task_activity (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),          -- NULL = automation (GitHub)
  kind text NOT NULL,                          -- 'state'|'assignee'|'priority'|'label'|'due'|'title'|'github_link'|...
  payload jsonb NOT NULL DEFAULT '{}',         -- {from, to, ...}
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_github_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo text NOT NULL,                          -- 'owner/name'
  kind text NOT NULL CHECK (kind IN ('branch','pr','issue')),
  ref text NOT NULL,                           -- branch name or number as text
  url text NOT NULL,
  title text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '',              -- 'open'|'draft'|'merged'|'closed'
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, url)
);

-- extend notifications kind constraint with 'task_assigned', 'task_comment'
```

Rules:

- Identifier = `{project.key}-{number}`. Allocation inside the insert transaction:
  `UPDATE projects SET next_number = next_number + 1 WHERE id=$1 RETURNING next_number - 1`.
- New projects are seeded with six states: Backlog (`backlog`), Todo (`unstarted`),
  In Progress / In Review (`started`), Done (`completed`), Canceled (`canceled`). Names
  and colors editable later; types fixed.
- Deletes are soft (`deleted_at`), matching messages/docs.
- Setting a state with type `completed` stamps `completed_at`; leaving it clears it.
- Task ids are UUIDs (JSON strings by nature). `number` is small — plain JSON number is
  fine; only message ids need the string-bigint rule.

## REST surface (all under `/api/v1`, workspace member unless noted)

| Method | Path | Notes |
|---|---|---|
| GET | `/projects` | with open-task counts |
| POST | `/projects` | `{key, name, icon?, channel_id?}` — validates key format/uniqueness, seeds states |
| PATCH | `/projects/{id}` | rename/icon/channel/archive; key immutable v1 |
| GET | `/projects/{id}/tasks?state_type=&assignee=&label=&priority=&q=` | list, soft-deleted excluded |
| POST | `/projects/{id}/tasks` | `{title, description?, state_id?, priority?, assignee_id?, label_ids?, due_date?, parent_id?, source_message_id?}` → `201 Task`; parent must be top-level (thread rule) |
| GET | `/tasks/{id}` | full task incl. labels, comments, activity, github links, sub-tasks |
| GET | `/tasks/by-key/{key}-{number}` | chip/deep-link resolution |
| PATCH | `/tasks/{id}` | any mutable field; writes `task_activity`, emits `task.updated`, notifies on assignee change |
| DELETE | `/tasks/{id}` | soft delete |
| POST | `/tasks/{id}/comments` | `{body}` → `201`; @mention parsing reuses notify.rs mention matching |
| PATCH/DELETE | `/task-comments/{id}` | author only; soft delete |
| GET | `/me/tasks` | open tasks assigned to me, grouped by project |
| GET | `/tasks/search?q=` | title ILIKE + identifier match, for pickers |
| GET/POST/PATCH/DELETE | `/task-labels` | workspace-level label CRUD |
| POST | `/integrations/github/webhook` | unauthenticated + HMAC signature check |

## WS events (main socket, broadcast to all workspace users)

- `project.created` / `project.updated` `{project}`
- `task.created` / `task.updated` `{task}` — task payload includes label ids and github
  link summaries so clients never refetch on drag
- `task.deleted` `{task_id, project_id}`
- `task.comment.created` / `.updated` / `.deleted`

Tasks are workspace-visible, so fanout is broadcast-all (no membership targeting —
simpler than polls). Redis pub/sub path unchanged.

## Web app

New fifth mode **Tasks** in the rail (icon: checkbox/target in `icons.tsx`). Routes:

- `/tasks` — home: My Issues (open, grouped by project) + project list
- `/t/:key` — project view, list/board toggle (persisted per project in localStorage)
- `/t/:key/:num` — deep link; opens the project view with the peek panel open

`web/src/components/tasks/`:

| Component | Steal from |
|---|---|
| `TasksHome` | Linear "My Issues"; layout mirrors `BoardHome` |
| `ProjectView` | header (icon, name, filter bar, view toggle, `c` hint) |
| `TaskListView` | Linear list: sections per state, dense rows — priority icon, `KEY-123` in muted mono, title, label chips, due date, assignee avatar |
| `TaskBoardView` | adapt `BoardColumn`/`BoardCard` visual language + reuse `useBoardDnd` and `fracIndex.between()` for drag; columns = states in `position` order |
| `TaskPeek` | Linear peek: slide-over like `CardPanel`/`SharpyPanel` — title, markdown description (edit-in-place), right property rail, GitHub links section, sub-tasks, comments + activity feed interleaved |
| `PropertyPicker` | Linear dropdowns: keyboard-filterable menus for state/priority/assignee/label/due |
| `NewTaskModal` | `c` opens anywhere in Tasks mode; project pre-selected from context |
| `FilterBar` | chips for state-type/assignee/label/priority |

Priority icons: hand-drawn SVGs in `icons.tsx` matching Linear's language (urgent = filled
square with `!`, high/medium/low = 3/2/1 signal bars, none = dash).

State: new store slices (`projects`, `tasks` keyed by project, `myTasks`), `ws.ts`
handlers apply `task.*` events in place; on WS reconnect refetch the active project's
tasks (same policy as channel list). All mutations optimistic (drag writes `sort_order`
immediately, server event confirms).

QuickSwitcher: typing an identifier (`SHARP-123`) jumps to the task; "Create task" action
added.

## Chat bridging

- **Auto-linkify**: `Markdown.tsx` matches `\b[A-Z][A-Z0-9]{1,5}-\d+\b` against known
  project keys (from store) and renders a task chip (state-colored dot + identifier +
  title on hover/fetch, navigates to `/t/:key/:num`). Unknown keys render as plain text.
- **Explicit chips**: `[[task:<uuid>|SHARP-123 Title]]` joins the existing
  `[[doc|canvas|board:]]` family; composer `[[` picker gets a Tasks section via
  `/tasks/search`.
- **Create from message**: message context-menu action "Create task…" — opens
  `NewTaskModal` prefilled (title = first line, description = quote + permalink), sets
  `source_message_id`; on create, posts a small system-style reply chip in the thread
  (like the poll card pattern) and shows the source message link in the peek.
- **Notifications**: `task_assigned` (someone assigned you; suppressed for
  self-assign) and `task_comment` (comment on a task you created/are assigned to, or
  @mention in a comment). Same pipeline as everything else in `notify.rs`: inbox row +
  `notification.created` + web push with `path: /t/:key/:num`. DND/mute semantics
  unchanged.

## GitHub sync

Config env-first (sharp house style): `GITHUB_TOKEN` (fine-grained PAT, repo scope),
`GITHUB_WEBHOOK_SECRET`, `GITHUB_REPOS` (comma-separated `owner/name` allowlist).
Feature inert when unset — same pattern as Sharpy's `AI_API_KEY`. GitHub App upgrade is
a later phase.

Server: `server/src/github.rs` (REST client, reqwest) + `server/src/routes/github.rs`
(webhook route + verification).

**Inbound webhook** (`X-Hub-Signature-256` HMAC verify, repo allowlist check). Events:

- `create` (branch) / `push`: branch name containing an identifier (case-insensitive
  `key-123` anywhere, Linear convention) → upsert `branch` link, move task to the
  project's first `started`-type state if its current state type is
  `backlog|unstarted`.
- `pull_request` opened/edited/ready_for_review: identifier from branch name, PR title,
  or magic words in body (`close[sd]?|fix(e[sd])?|resolve[sd]?\s+KEY-123`) → upsert `pr`
  link (state `open`/`draft`), same started-automation.
- `pull_request` closed with `merged: true` → link state `merged`, move task to first
  `completed`-type state (stamps `completed_at`).
- `pull_request` closed unmerged → link state `closed`, task state untouched.

All automation writes `task_activity` with `actor_id NULL` and emits `task.updated`;
webhook processing is idempotent (upsert by `(task_id, url)`, state moves are no-ops if
already at/past target type).

**Outbound v1** (zero API calls needed):

- **Copy branch name** button on the peek: `{key}-{number}-{slug}` lowercased,
  slug from title, ≤ 60 chars — the Linear flow that makes branch↔task linking work.

**Outbound v2 (later)**: create GitHub issue from task, PR comment on state change,
issue mirroring.

## Sharpy integration

Embed tasks like messages/docs: content = `KEY-123 title + description + comments`,
re-embed on edit, drop on delete. ACL is trivial (workspace-visible), so retrieval just
requires a registered user. Hooks into the existing 15s self-healing worker + immediate
embed on create. Sharpy learns to answer "what's assigned to me?" / "what's in review?"
via retrieved task rows (identifier included in the source chip, deep-links to
`/t/:key/:num`).

## Delivery phases

Each phase compiles (`cargo check`) and typechecks (`bun run build`) independently;
ARCHITECTURE.md Phase 7 section is written with phase A and extended per phase.

- **A — Core tracker** (biggest): migration 0023, models, REST, WS events, store/api/ws
  wiring, Tasks mode (home, list, board, peek, pickers, new-task modal), identifiers,
  My Issues, labels. E2E: two browsers, create/drag/assign, live updates.
- **B — Chat bridging + notifications**: linkify + chips, `[[` picker section,
  create-from-message, QuickSwitcher, `task_assigned`/`task_comment` kinds (+ constraint
  migration alter in 0023 from the start), push deep links.
- **C — GitHub sync**: github.rs client, webhook route + HMAC, link upserts, state
  automation, links UI on peek, copy-branch-name. E2E with a real repo + smee/dev
  tunnel.
- **D — Sharpy + polish**: task embeddings + retrieval, filter bar persistence, due-date
  surfacing (badge in list; calendar integration deferred), archived projects.

Order within a phase: ARCHITECTURE.md contract → migration → models/routes/WS → web
types/api/store → UI → e2e.
