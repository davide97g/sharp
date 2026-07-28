use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::routes::{is_workspace_admin, require_workspace_admin};
use crate::state::SharedState;
use crate::ws::envelope;
use crate::ws::garden::{
    is_garden_avatar, plot_door, GARDEN_AVATARS, HUB_MAX_X, HUB_MAX_Y, HUB_SPAWN_X, HUB_SPAWN_Y,
    TEMPLE_X, TEMPLE_Y,
};
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

/// Scenery a client may place. Validated here so an arbitrary string never
/// reaches another client's texture lookup, and never lands in a row that would
/// then fail to render. Mirrored by `PROP_IDS` in
/// `web/src/components/garden/gardenProps.ts` — keep the two in lockstep.
pub const GARDEN_PROP_IDS: [&str; 15] = [
    "tree_wide",
    "tree_tall",
    "boulder",
    "rock_brown",
    "rock_grey",
    "pebble",
    "stump",
    "log",
    "post",
    "bush",
    "tuft",
    "flower_yellow",
    "flower_red",
    "berry_bush",
    "berry_bush_blue",
];

/// One gesture is one request, so a drag or a multi-delete is a single round trip
/// and a single broadcast.
const MAX_OPS_PER_REQUEST: usize = 64;
/// Ceiling on total scenery. Bounded by map-fetch size, not by database cost.
const MAX_OBJECTS: i64 = 1500;

pub fn is_garden_prop(kind: &str) -> bool {
    GARDEN_PROP_IDS.contains(&kind)
}

#[derive(Serialize)]
pub struct GardenRoom {
    channel_id: Uuid,
    name: String,
    kind: String,
    is_member: bool,
    plot_index: i32,
    room_variant: String,
    occupancy: usize,
    door_x: f64,
    door_y: f64,
}

#[derive(Serialize)]
pub struct GardenMap {
    version: i32,
    tile_size: i32,
    spawn: GardenPoint,
    temple: GardenPoint,
    rooms: Vec<GardenRoom>,
    /// The caller's chosen character, or `null` when they have never picked —
    /// which is what the first-join picker keys off. Viewer-scoped: a peer's
    /// choice arrives on the peer, never here.
    self_avatar: Option<String>,
    /// The server's roster allowlist, so the picker cannot drift out of lockstep
    /// with what the server will accept.
    avatars: Vec<&'static str>,
    /// Whether this viewer may edit the world. The only place the admin flag is
    /// exposed to a client — `models::User` is deliberately untouched, since it is
    /// shared with `GET /users`.
    can_edit: bool,
    /// Placed scenery, in paint order.
    objects: Vec<GardenObject>,
    /// The server's scenery allowlist, so the palette cannot offer a rejected id.
    props: Vec<&'static str>,
}

#[derive(Serialize)]
pub struct GardenObject {
    id: Uuid,
    kind: String,
    x: f64,
    y: f64,
    flip: bool,
}

#[derive(Serialize)]
struct GardenPoint {
    x: f64,
    y: f64,
}

pub async fn map(State(state): State<SharedState>, auth: AuthUser) -> AppResult<Json<GardenMap>> {
    let rows = sqlx::query(
        "SELECT c.id, c.name, c.kind, gr.plot_index, gr.room_variant,
                (cm.user_id IS NOT NULL) AS is_member
           FROM garden_rooms gr
           JOIN channels c ON c.id = gr.channel_id
           LEFT JOIN channel_members cm
             ON cm.channel_id = c.id AND cm.user_id = $1
          WHERE c.kind = 'public' OR cm.user_id IS NOT NULL
          ORDER BY gr.plot_index",
    )
    .bind(auth.id)
    .fetch_all(&state.pool)
    .await?;
    let self_avatar: Option<String> =
        sqlx::query("SELECT garden_avatar FROM user_prefs WHERE user_id = $1")
            .bind(auth.id)
            .fetch_optional(&state.pool)
            .await?
            .and_then(|row| row.try_get::<Option<String>, _>("garden_avatar").ok())
            .flatten()
            .filter(|value| is_garden_avatar(value));
    let can_edit = is_workspace_admin(&state.pool, auth.id).await?;
    let objects = load_objects(&state).await?;
    let occupancy = state.garden.occupancy();
    let mut rooms = Vec::with_capacity(rows.len());
    for row in rows {
        let channel_id: Uuid = row.try_get("id")?;
        let plot_index: i32 = row.try_get("plot_index")?;
        let (door_x, door_y) = plot_door(plot_index);
        rooms.push(GardenRoom {
            channel_id,
            name: row.try_get("name")?,
            kind: row.try_get("kind")?,
            is_member: row.try_get("is_member")?,
            plot_index,
            room_variant: row.try_get("room_variant")?,
            occupancy: occupancy.get(&channel_id).copied().unwrap_or(0),
            door_x,
            door_y,
        });
    }
    Ok(Json(GardenMap {
        version: 2,
        tile_size: 16,
        spawn: GardenPoint {
            x: HUB_SPAWN_X,
            y: HUB_SPAWN_Y,
        },
        temple: GardenPoint {
            x: TEMPLE_X,
            y: TEMPLE_Y,
        },
        rooms,
        self_avatar,
        avatars: GARDEN_AVATARS.to_vec(),
        can_edit,
        objects,
        props: GARDEN_PROP_IDS.to_vec(),
    }))
}

async fn load_objects(state: &SharedState) -> AppResult<Vec<GardenObject>> {
    let rows = sqlx::query("SELECT id, kind, x, y, flip FROM garden_objects ORDER BY y, x")
        .fetch_all(&state.pool)
        .await?;
    let mut objects = Vec::with_capacity(rows.len());
    for row in rows {
        objects.push(GardenObject {
            id: row.try_get("id")?,
            kind: row.try_get("kind")?,
            x: row.try_get("x")?,
            y: row.try_get("y")?,
            flip: row.try_get("flip")?,
        });
    }
    Ok(objects)
}

// --- Creator mode ----------------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum LayoutOp {
    /// Idempotent on replay: the client owns the id.
    Add {
        id: Uuid,
        kind: String,
        x: f64,
        y: f64,
        #[serde(default)]
        flip: bool,
    },
    Move {
        id: Uuid,
        x: f64,
        y: f64,
        #[serde(default)]
        flip: bool,
    },
    Remove {
        id: Uuid,
    },
}

#[derive(Deserialize)]
pub struct SaveLayoutRequest {
    ops: Vec<LayoutOp>,
}

/// Snap to a half tile and clamp inside the hub, so no NaN, infinity or
/// out-of-world coordinate can ever reach a row. Shares the hub bounds with
/// movement, so the two cannot disagree.
fn clamp_placement(x: f64, y: f64) -> AppResult<(f64, f64)> {
    if !x.is_finite() || !y.is_finite() {
        return Err(AppError::Validation("coordinates must be finite".to_string()));
    }
    let snap = |v: f64| (v * 2.0).round() / 2.0;
    Ok((
        snap(x.clamp(0.0, HUB_MAX_X)),
        snap(y.clamp(0.0, HUB_MAX_Y)),
    ))
}

/// Refuse scenery that would block a doorway or the plaza. An admin must not be
/// able to wall the workspace out of its own rooms.
fn placement_is_allowed(x: f64, y: f64, doors: &[(f64, f64)]) -> bool {
    // The plaza core, where the signpost and the through-lanes are.
    if (x - 52.0).abs() <= 3.0 && (y - 64.0).abs() <= 2.0 {
        return false
    }
    // The temple threshold.
    if (x - TEMPLE_X).abs() <= 2.0 && (y - TEMPLE_Y).abs() <= 2.0 {
        return false
    }
    // Every doorway and the tile in front of it.
    doors
        .iter()
        .all(|(door_x, door_y)| (x - door_x).abs() > 1.5 || (y - door_y).abs() > 1.5)
}

pub async fn save_layout(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<SaveLayoutRequest>,
) -> AppResult<Json<serde_json::Value>> {
    require_workspace_admin(&state.pool, auth.id).await?;
    if body.ops.is_empty() || body.ops.len() > MAX_OPS_PER_REQUEST {
        return Err(AppError::Validation(format!(
            "between 1 and {MAX_OPS_PER_REQUEST} ops required"
        )));
    }

    // Doorways come from the same deterministic function the proximity check uses.
    let door_rows = sqlx::query("SELECT plot_index FROM garden_rooms")
        .fetch_all(&state.pool)
        .await?;
    let mut doors = Vec::with_capacity(door_rows.len());
    for row in door_rows {
        doors.push(plot_door(row.try_get::<i32, _>("plot_index")?));
    }

    let mut tx = state.pool.begin().await?;
    for op in &body.ops {
        match op {
            LayoutOp::Add { id, kind, x, y, flip } => {
                if !is_garden_prop(kind) {
                    return Err(AppError::Validation(format!("unknown scenery: {kind}")));
                }
                let (cx, cy) = clamp_placement(*x, *y)?;
                if !placement_is_allowed(cx, cy, &doors) {
                    return Err(AppError::Validation(
                        "that spot has to stay clear".to_string(),
                    ));
                }
                sqlx::query(
                    "INSERT INTO garden_objects (id, kind, x, y, flip, created_by)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (id) DO NOTHING",
                )
                .bind(id)
                .bind(kind)
                .bind(cx)
                .bind(cy)
                .bind(flip)
                .bind(auth.id)
                .execute(&mut *tx)
                .await?;
            }
            LayoutOp::Move { id, x, y, flip } => {
                let (cx, cy) = clamp_placement(*x, *y)?;
                if !placement_is_allowed(cx, cy, &doors) {
                    return Err(AppError::Validation(
                        "that spot has to stay clear".to_string(),
                    ));
                }
                sqlx::query(
                    "UPDATE garden_objects SET x = $2, y = $3, flip = $4, updated_at = now()
                     WHERE id = $1",
                )
                .bind(id)
                .bind(cx)
                .bind(cy)
                .bind(flip)
                .execute(&mut *tx)
                .await?;
            }
            LayoutOp::Remove { id } => {
                sqlx::query("DELETE FROM garden_objects WHERE id = $1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }

    let total: i64 = sqlx::query("SELECT count(*) AS c FROM garden_objects")
        .fetch_one(&mut *tx)
        .await?
        .try_get("c")?;
    if total > MAX_OBJECTS {
        // Rolls back by dropping the transaction, so an over-cap batch places
        // nothing rather than part of itself.
        return Err(AppError::Validation(format!(
            "the Garden is full ({MAX_OBJECTS} pieces of scenery)"
        )));
    }
    tx.commit().await?;

    // The layout is public, so this goes to every online user; a client not in
    // Garden simply ignores it.
    let objects = load_objects(&state).await?;
    state
        .hub
        .broadcast(
            envelope(
                "garden.layout_changed",
                json!({ "objects": objects, "actor_id": auth.id }),
            ),
            state.hub.online_user_ids(),
        )
        .await;

    Ok(Json(json!({ "objects": objects })))
}

#[cfg(test)]
mod tests {
    use super::{clamp_placement, is_garden_prop, placement_is_allowed};
    use crate::ws::garden::plot_door;

    #[test]
    fn scenery_is_allowlisted() {
        assert!(is_garden_prop("boulder"));
        assert!(!is_garden_prop("../../etc/passwd"));
        assert!(!is_garden_prop(""));
    }

    #[test]
    fn placements_snap_to_a_half_tile_and_clamp_into_the_hub() {
        assert_eq!(clamp_placement(10.3, 20.9).unwrap(), (10.5, 21.0));
        assert_eq!(clamp_placement(-50.0, 9999.0).unwrap(), (0.0, 398.0));
    }

    #[test]
    fn non_finite_placements_are_refused() {
        assert!(clamp_placement(f64::NAN, 1.0).is_err());
        assert!(clamp_placement(1.0, f64::INFINITY).is_err());
    }

    #[test]
    fn doorways_and_the_plaza_stay_clear() {
        let doors = vec![plot_door(0), plot_door(3)];
        // Right on a doorway, and the tile in front of it.
        assert!(!placement_is_allowed(14.0, 19.0, &doors));
        assert!(!placement_is_allowed(14.0, 20.0, &doors));
        // The plaza core and the temple threshold.
        assert!(!placement_is_allowed(52.0, 64.0, &doors));
        assert!(!placement_is_allowed(52.0, 84.0, &doors));
        // Open ground is fine.
        assert!(placement_is_allowed(30.0, 40.0, &doors));
    }
}
