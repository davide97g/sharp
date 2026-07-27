-- Persistent Garden plot assignment. Presence and movement stay ephemeral.
CREATE TABLE garden_rooms (
    channel_id uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    plot_index integer NOT NULL UNIQUE CHECK (plot_index >= 0),
    room_variant text NOT NULL DEFAULT 'meadow'
        CHECK (room_variant IN ('meadow', 'pond', 'orchard', 'greenhouse')),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Serialize plot allocation so concurrent channel creation cannot pick the same slot.
CREATE OR REPLACE FUNCTION allocate_garden_room()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    next_plot integer;
    variants text[] := ARRAY['meadow', 'pond', 'orchard', 'greenhouse'];
BEGIN
    IF NEW.kind = 'dm' THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(19357641);
    SELECT COALESCE(max(plot_index) + 1, 0) INTO next_plot FROM garden_rooms;
    INSERT INTO garden_rooms (channel_id, plot_index, room_variant)
    VALUES (NEW.id, next_plot, variants[(next_plot % 4) + 1]);
    RETURN NEW;
END;
$$;

CREATE TRIGGER channels_allocate_garden_room
AFTER INSERT ON channels
FOR EACH ROW
EXECUTE FUNCTION allocate_garden_room();

-- Stable backfill for existing public/private channels.
DO $$
DECLARE
    row_record record;
    next_plot integer := 0;
    variants text[] := ARRAY['meadow', 'pond', 'orchard', 'greenhouse'];
BEGIN
    FOR row_record IN
        SELECT id FROM channels WHERE kind <> 'dm' ORDER BY created_at, id
    LOOP
        INSERT INTO garden_rooms (channel_id, plot_index, room_variant)
        VALUES (
            row_record.id,
            next_plot,
            variants[(next_plot % 4) + 1]
        )
        ON CONFLICT (channel_id) DO NOTHING;
        next_plot := next_plot + 1;
    END LOOP;
END;
$$;
