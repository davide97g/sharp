-- Remove the internal task tracker. Boards remain the workspace's flexible
-- capture surface; task execution belongs to external systems.

DELETE FROM notifications WHERE channel_id IS NULL;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE notifications DROP COLUMN task_id;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('mention','dm','reply','poll_ended'));

ALTER TABLE user_prefs DROP COLUMN notify_task;

DROP TABLE project_github_repos;
DROP TABLE task_embeddings;
DROP TABLE task_github_links;
DROP TABLE task_activity;
DROP TABLE task_comments;
DROP TABLE task_label_assignments;
DROP TABLE task_labels;
DROP TABLE tasks;
DROP TABLE task_states;
DROP TABLE projects;
