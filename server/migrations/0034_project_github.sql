-- Phase 7E: per-project GitHub repository links.
--
-- Until now GitHub sync was env-only (one global GITHUB_WEBHOOK_SECRET + optional
-- GITHUB_REPOS allowlist). A project can now own its repositories: each link carries
-- its own webhook secret (generated server-side, so no env/restart is needed) and an
-- optional PAT, sealed with the same AES-256-GCM helper the calendar tokens use, that
-- lets the server verify the repo, read its visibility, and install the webhook itself.
-- The env path stays valid as a fallback for existing deploys.

-- Branch naming convention. '' means the built-in `{identifier}-{slug}`.
ALTER TABLE projects ADD COLUMN branch_template text NOT NULL DEFAULT '';

CREATE TABLE project_github_repos (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repo            text NOT NULL,            -- 'owner/name', as GitHub spells it
    secret          text NOT NULL,            -- webhook HMAC secret (generated here)
    token_enc       text,                     -- sealed PAT; NULL in manual mode
    visibility      text NOT NULL DEFAULT '', -- '' unknown | 'public' | 'private' | 'internal'
    default_branch  text NOT NULL DEFAULT '',
    hook_id         bigint,                   -- set when we installed the webhook via the API
    hook_active     boolean NOT NULL DEFAULT false,
    last_error      text NOT NULL DEFAULT '',
    last_event_at   timestamptz,
    last_event_kind text NOT NULL DEFAULT '',
    connected_by    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, repo)
);

-- Webhook deliveries resolve by repository name; several projects may share one repo
-- (monorepo with multiple keys), so this is deliberately not unique.
CREATE INDEX project_github_repos_repo_idx ON project_github_repos (lower(repo));
