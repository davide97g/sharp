-- Link previews (unfurls): a message's links rendered as cards, Discord-style.
--
-- Two tables on purpose. `link_previews` is a workspace-wide cache keyed by the
-- normalized URL, so the hundredth person to paste the same article costs one
-- row and zero outbound requests. `message_link_previews` is only the ordering:
-- which cards a message shows, and in which order.
--
-- Failures are cached too (`kind = 'error'`), with a much shorter TTL enforced
-- in `server/src/unfurl.rs` — a dead link must not mean a fetch attempt on every
-- refetch, and a transient 500 must not be remembered for a week.
CREATE TABLE link_previews (
    -- Normalized absolute URL (scheme + host lowercased, fragment stripped).
    -- Capped at 2048 chars by the unfurler so it always fits a btree entry.
    url          text PRIMARY KEY,
    -- 'link' | 'photo' | 'video' | 'error'
    kind         text        NOT NULL,
    title        text,
    description  text,
    site_name    text,
    author       text,
    image_url    text,
    image_width  integer,
    image_height integer,
    favicon_url  text,
    -- Player URL for the click-to-play frame. Only ever set for the allowlisted
    -- video hosts in unfurl.rs — never taken from a page's own og:video.
    embed_url    text,
    -- theme-color, used to tint the card's accent bar.
    color        text,
    fetched_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_link_previews (
    message_id bigint  NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    position   integer NOT NULL,
    url        text    NOT NULL REFERENCES link_previews(url) ON DELETE CASCADE,
    PRIMARY KEY (message_id, position)
);

CREATE INDEX message_link_previews_url_idx ON message_link_previews (url);

-- The author's "remove preview" ✕. Kept on the message rather than the join rows
-- so an edit that adds a new link stays suppressed: the choice is about the
-- message, not about one particular card.
ALTER TABLE messages
    ADD COLUMN previews_hidden boolean NOT NULL DEFAULT false;
