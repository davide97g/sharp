ALTER TABLE channel_members
  ADD COLUMN role text NOT NULL DEFAULT 'editor'
  CHECK (role IN ('owner','editor','viewer'));

UPDATE channel_members cm
SET role = 'owner'
FROM channels c
WHERE c.id = cm.channel_id
  AND c.kind <> 'dm'
  AND c.created_by = cm.user_id;

-- safety net: ownerless non-DM channels get their oldest member as owner
UPDATE channel_members cm SET role = 'owner'
WHERE cm.channel_id IN (
  SELECT c.id FROM channels c
  WHERE c.kind <> 'dm'
    AND NOT EXISTS (SELECT 1 FROM channel_members x WHERE x.channel_id = c.id AND x.role = 'owner')
)
AND cm.joined_at = (SELECT min(joined_at) FROM channel_members y WHERE y.channel_id = cm.channel_id);
