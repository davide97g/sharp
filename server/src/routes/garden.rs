use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::state::SharedState;
use crate::ws::garden::{plot_door, HUB_SPAWN_X, HUB_SPAWN_Y};
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
    rooms: Vec<GardenRoom>,
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
        version: 1,
        tile_size: 16,
        spawn: GardenPoint {
            x: HUB_SPAWN_X,
            y: HUB_SPAWN_Y,
        },
        rooms,
    }))
}
