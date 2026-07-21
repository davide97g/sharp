-- Phase 7: Tasks (Linear-lite planner)

CREATE TABLE projects (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key         text NOT NULL UNIQUE
        CHECK (key ~ '^[A-Z][A-Z0-9]{1,5}$'),
    name        text NOT NULL,
    icon        text NOT NULL DEFAULT '',
    channel_id  uuid REFERENCES channels(id) ON DELETE SET NULL,
    next_number bigint NOT NULL DEFAULT 1,
    created_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    archived_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_states (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       text NOT NULL,
    color      text NOT NULL,
    type       text NOT NULL
        CHECK (type IN ('backlog','unstarted','started','completed','canceled')),
    position   int NOT NULL
);

CREATE INDEX task_states_project_idx ON task_states (project_id, position);

CREATE TABLE tasks (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number            bigint NOT NULL,
    title             text NOT NULL,
    description       text NOT NULL DEFAULT '',
    state_id          uuid NOT NULL REFERENCES task_states(id),
    priority          smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
    assignee_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    creator_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id         uuid REFERENCES tasks(id) ON DELETE SET NULL,
    due_date          date,
    sort_order        text NOT NULL,
    source_message_id bigint REFERENCES messages(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    completed_at      timestamptz,
    deleted_at        timestamptz,
    UNIQUE (project_id, number)
);

CREATE INDEX tasks_project_open_idx ON tasks (project_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_parent_idx ON tasks (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE task_labels (
    id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name  text NOT NULL UNIQUE,
    color text NOT NULL
);

CREATE TABLE task_label_assignments (
    task_id  uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label_id uuid NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
);

CREATE TABLE task_comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz,
    deleted_at timestamptz
);

CREATE INDEX task_comments_task_idx ON task_comments (task_id, created_at);

CREATE TABLE task_activity (
    id         bigserial PRIMARY KEY,
    task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    kind       text NOT NULL,
    payload    jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_activity_task_idx ON task_activity (task_id, id);

CREATE TABLE task_github_links (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    repo       text NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('branch','pr','issue')),
    ref        text NOT NULL,
    url        text NOT NULL,
    title      text NOT NULL DEFAULT '',
    state      text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, url)
);

-- Task notifications reference a task, not a channel/message.
ALTER TABLE notifications ALTER COLUMN channel_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN task_id uuid REFERENCES tasks(id) ON DELETE CASCADE;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('mention','dm','reply','poll_ended','task_assigned','task_comment'));
