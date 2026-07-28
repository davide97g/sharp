use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::state::SharedState;
use crate::ws::garden::{
    is_garden_avatar, plot_door, GARDEN_AVATARS, HUB_SPAWN_X, HUB_SPAWN_Y, TEMPLE_X, TEMPLE_Y,
};
use axum::extract::State;
use axum::Json;
use serde::Serialize;
use sqlx::Row;
use uuid::Uuid;

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
    }))
}
