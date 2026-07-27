//! Garden presence and movement on the main WebSocket.
//!
//! The hub is a public scene. Channel interiors are separate scenes whose
//! audience is the channel membership. Private channel metadata never enters a
//! non-member payload.

use crate::routes::{channel_kind, is_member};
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope, WsSender};
use axum::extract::ws::Message;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

pub const HUB_SPAWN_X: f64 = 52.0;
pub const HUB_SPAWN_Y: f64 = 64.0;
const HUB_MIN_X: f64 = 2.0;
const HUB_MAX_X: f64 = 102.0;
const HUB_MIN_Y: f64 = 2.0;
// Four plots per row; vertical headroom lets the village grow with channels.
const HUB_MAX_Y: f64 = 398.0;
const ROOM_MIN_X: f64 = 2.0;
const ROOM_MAX_X: f64 = 30.0;
const ROOM_MIN_Y: f64 = 2.0;
const ROOM_MAX_Y: f64 = 22.0;
const ROOM_SPAWN_X: f64 = 16.0;
const ROOM_SPAWN_Y: f64 = 19.0;
const MAX_SPEED_TILES_PER_SECOND: f64 = 8.0;
const MOVE_SLACK: f64 = 1.5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GardenSpace {
    Hub,
    Room(Uuid),
}

#[derive(Clone, Debug, Serialize)]
pub struct GardenPeer {
    pub conn_id: Uuid,
    pub user_id: Uuid,
    pub display_name: String,
    pub space: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<Uuid>,
    pub x: f64,
    pub y: f64,
    pub facing: String,
    pub moving: bool,
    pub seq: u64,
    #[serde(skip)]
    pub last_move_at: Instant,
}

impl GardenPeer {
    fn new(conn_id: Uuid, user_id: Uuid, display_name: &str) -> Self {
        Self {
            conn_id,
            user_id,
            display_name: display_name.to_string(),
            space: "hub",
            channel_id: None,
            x: HUB_SPAWN_X,
            y: HUB_SPAWN_Y,
            facing: "down".to_string(),
            moving: false,
            seq: 0,
            last_move_at: Instant::now(),
        }
    }

    fn garden_space(&self) -> GardenSpace {
        self.channel_id
            .map(GardenSpace::Room)
            .unwrap_or(GardenSpace::Hub)
    }

    fn set_space(&mut self, space: GardenSpace, x: f64, y: f64) {
        match space {
            GardenSpace::Hub => {
                self.space = "hub";
                self.channel_id = None;
            }
            GardenSpace::Room(channel_id) => {
                self.space = "room";
                self.channel_id = Some(channel_id);
            }
        }
        self.x = x;
        self.y = y;
        self.moving = false;
        self.last_move_at = Instant::now();
    }
}

#[derive(Default)]
pub struct GardenState {
    peers: Mutex<HashMap<Uuid, GardenPeer>>,
}

impl GardenState {
    pub fn occupancy(&self) -> HashMap<Uuid, usize> {
        let guard = self.peers.lock().unwrap();
        let mut counts = HashMap::new();
        for peer in guard.values() {
            if let Some(channel_id) = peer.channel_id {
                *counts.entry(channel_id).or_insert(0) += 1;
            }
        }
        counts
    }
}

fn send(tx: &WsSender, event_type: &str, payload: Value) {
    let _ = tx.send(Message::Text(envelope(event_type, payload).to_string()));
}

async fn targets_for_space(state: &SharedState, space: &GardenSpace) -> Vec<Uuid> {
    match space {
        GardenSpace::Hub => state.hub.online_user_ids(),
        GardenSpace::Room(channel_id) => channel_member_ids(&state.pool, *channel_id)
            .await
            .unwrap_or_default(),
    }
}

async fn broadcast_left(state: &SharedState, peer: &GardenPeer, space: &GardenSpace) {
    let targets = targets_for_space(state, space).await;
    state
        .hub
        .broadcast(
            envelope(
                "garden.peer_left",
                json!({ "conn_id": peer.conn_id.to_string() }),
            ),
            targets,
        )
        .await;
}

async fn broadcast_joined(state: &SharedState, peer: &GardenPeer) {
    let targets = targets_for_space(state, &peer.garden_space()).await;
    state
        .hub
        .broadcast(
            envelope("garden.peer_joined", json!({ "peer": peer })),
            targets,
        )
        .await;
}

async fn peers_visible_to(
    state: &SharedState,
    user_id: Uuid,
    space: &GardenSpace,
) -> Vec<GardenPeer> {
    if let GardenSpace::Room(channel_id) = space {
        if !is_member(&state.pool, *channel_id, user_id)
            .await
            .unwrap_or(false)
        {
            return Vec::new();
        }
    }
    let guard = state.garden.peers.lock().unwrap();
    guard
        .values()
        .filter(|peer| &peer.garden_space() == space)
        .cloned()
        .collect()
}

pub async fn handle_event(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    display_name: &str,
    event_type: &str,
    payload: Value,
    tx: &WsSender,
) {
    match event_type {
        "garden.enter" => handle_enter(state, user_id, conn_id, display_name, tx).await,
        "garden.leave" => cleanup_conn(state, conn_id).await,
        "garden.move" => handle_move(state, conn_id, &payload, tx).await,
        "garden.room_enter" => handle_room_enter(state, user_id, conn_id, &payload, tx).await,
        "garden.room_exit" => handle_room_exit(state, conn_id, tx).await,
        _ => {}
    }
}

async fn handle_enter(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    display_name: &str,
    tx: &WsSender,
) {
    let peer = {
        let mut guard = state.garden.peers.lock().unwrap();
        guard
            .entry(conn_id)
            .or_insert_with(|| GardenPeer::new(conn_id, user_id, display_name))
            .clone()
    };
    let peers = peers_visible_to(state, user_id, &peer.garden_space()).await;
    send(tx, "garden.state", json!({ "self": peer, "peers": peers }));
    broadcast_joined(state, &peer).await;
}

#[derive(Deserialize)]
struct MovePayload {
    seq: u64,
    x: f64,
    y: f64,
    facing: String,
}

fn valid_facing(value: &str) -> bool {
    matches!(value, "up" | "down" | "left" | "right")
}

fn clamped_for_space(space: &GardenSpace, x: f64, y: f64) -> (f64, f64) {
    match space {
        GardenSpace::Hub => (x.clamp(HUB_MIN_X, HUB_MAX_X), y.clamp(HUB_MIN_Y, HUB_MAX_Y)),
        GardenSpace::Room(_) => (
            x.clamp(ROOM_MIN_X, ROOM_MAX_X),
            y.clamp(ROOM_MIN_Y, ROOM_MAX_Y),
        ),
    }
}

async fn handle_move(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Ok(payload) = serde_json::from_value::<MovePayload>(payload.clone()) else {
        return;
    };
    if !payload.x.is_finite() || !payload.y.is_finite() || !valid_facing(&payload.facing) {
        return;
    }
    let result = {
        let mut guard = state.garden.peers.lock().unwrap();
        let Some(peer) = guard.get_mut(&conn_id) else {
            return;
        };
        if payload.seq <= peer.seq {
            return;
        }
        let now = Instant::now();
        let elapsed = now
            .duration_since(peer.last_move_at)
            .as_secs_f64()
            .max(0.016);
        let allowed = MAX_SPEED_TILES_PER_SECOND * elapsed + MOVE_SLACK;
        let (x, y) = clamped_for_space(&peer.garden_space(), payload.x, payload.y);
        let distance = ((x - peer.x).powi(2) + (y - peer.y).powi(2)).sqrt();
        if distance > allowed {
            Err((peer.seq, peer.x, peer.y))
        } else {
            peer.seq = payload.seq;
            peer.x = x;
            peer.y = y;
            peer.facing = payload.facing;
            peer.moving = distance > 0.01;
            peer.last_move_at = now;
            Ok((peer.clone(), peer.garden_space()))
        }
    };
    let (peer, space) = match result {
        Ok(value) => value,
        Err((seq, x, y)) => {
            send(
                tx,
                "garden.corrected",
                json!({ "seq": seq, "x": x, "y": y }),
            );
            return;
        }
    };
    let targets = targets_for_space(state, &space).await;
    state
        .hub
        .broadcast(
            envelope(
                "garden.peer_moved",
                json!({
                    "conn_id": peer.conn_id.to_string(),
                    "seq": peer.seq,
                    "x": peer.x,
                    "y": peer.y,
                    "facing": peer.facing,
                    "moving": peer.moving,
                }),
            ),
            targets,
        )
        .await;
    if let GardenSpace::Room(channel_id) = space {
        let room_x = ((peer.x - ROOM_MIN_X) / (ROOM_MAX_X - ROOM_MIN_X)).clamp(0.0, 1.0);
        let room_y = ((peer.y - ROOM_MIN_Y) / (ROOM_MAX_Y - ROOM_MIN_Y)).clamp(0.0, 1.0);
        crate::ws::voice::move_garden_participant(state, channel_id, conn_id, room_x, room_y).await;
    }
}

pub fn plot_door(plot_index: i32) -> (f64, f64) {
    let column = (plot_index.rem_euclid(4)) as f64;
    let row = (plot_index.div_euclid(4)) as f64;
    (14.0 + column * 24.0, 19.0 + row * 19.0)
}

async fn handle_room_enter(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    payload: &Value,
    tx: &WsSender,
) {
    let Some(channel_id) = payload
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
    else {
        return;
    };
    let kind = channel_kind(&state.pool, channel_id).await.ok().flatten();
    if !matches!(kind.as_deref(), Some("public" | "private"))
        || !is_member(&state.pool, channel_id, user_id)
            .await
            .unwrap_or(false)
    {
        send(
            tx,
            "garden.error",
            json!({ "code": "not_member", "channel_id": channel_id }),
        );
        return;
    }
    let plot_index =
        sqlx::query_scalar::<_, i32>("SELECT plot_index FROM garden_rooms WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
    let Some(plot_index) = plot_index else {
        return;
    };
    let old_peer = {
        let guard = state.garden.peers.lock().unwrap();
        guard.get(&conn_id).cloned()
    };
    let Some(old_peer) = old_peer else {
        return;
    };
    if old_peer.channel_id.is_some() {
        return;
    }
    let (door_x, door_y) = plot_door(plot_index);
    if ((old_peer.x - door_x).powi(2) + (old_peer.y - door_y).powi(2)).sqrt() > 4.5 {
        send(
            tx,
            "garden.error",
            json!({ "code": "not_at_door", "channel_id": channel_id }),
        );
        return;
    }
    broadcast_left(state, &old_peer, &GardenSpace::Hub).await;
    let peer = {
        let mut guard = state.garden.peers.lock().unwrap();
        let Some(peer) = guard.get_mut(&conn_id) else {
            return;
        };
        peer.set_space(GardenSpace::Room(channel_id), ROOM_SPAWN_X, ROOM_SPAWN_Y);
        peer.clone()
    };
    send(
        tx,
        "garden.space_changed",
        json!({ "space": "room", "channel_id": channel_id, "peer": peer }),
    );
    broadcast_joined(state, &peer).await;
}

async fn handle_room_exit(state: &SharedState, conn_id: Uuid, tx: &WsSender) {
    let old_peer = {
        let guard = state.garden.peers.lock().unwrap();
        guard.get(&conn_id).cloned()
    };
    let Some(old_peer) = old_peer else {
        return;
    };
    let Some(channel_id) = old_peer.channel_id else {
        return;
    };
    let plot_index =
        sqlx::query_scalar::<_, i32>("SELECT plot_index FROM garden_rooms WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
            .unwrap_or(0);
    broadcast_left(state, &old_peer, &GardenSpace::Room(channel_id)).await;
    let (door_x, door_y) = plot_door(plot_index);
    let peer = {
        let mut guard = state.garden.peers.lock().unwrap();
        let Some(peer) = guard.get_mut(&conn_id) else {
            return;
        };
        peer.set_space(GardenSpace::Hub, door_x, door_y + 2.0);
        peer.clone()
    };
    send(
        tx,
        "garden.space_changed",
        json!({ "space": "hub", "peer": peer }),
    );
    broadcast_joined(state, &peer).await;
}

pub async fn cleanup_conn(state: &SharedState, conn_id: Uuid) {
    let peer = {
        let mut guard = state.garden.peers.lock().unwrap();
        guard.remove(&conn_id)
    };
    if let Some(peer) = peer {
        let space = peer.garden_space();
        broadcast_left(state, &peer, &space).await;
    }
}

pub async fn remove_member_from_room(state: &SharedState, channel_id: Uuid, user_id: Uuid) {
    let peers: Vec<(GardenPeer, GardenPeer)> = {
        let mut guard = state.garden.peers.lock().unwrap();
        guard
            .values_mut()
            .filter(|peer| peer.user_id == user_id && peer.channel_id == Some(channel_id))
            .map(|peer| {
                let old = peer.clone();
                peer.set_space(GardenSpace::Hub, HUB_SPAWN_X, HUB_SPAWN_Y);
                (old, peer.clone())
            })
            .collect()
    };
    for (old, current) in peers {
        broadcast_left(state, &old, &GardenSpace::Room(channel_id)).await;
        state
            .hub
            .broadcast(
                envelope(
                    "garden.space_changed",
                    json!({ "space": "hub", "peer": current }),
                ),
                vec![user_id],
            )
            .await;
        broadcast_joined(state, &current).await;
    }
}

pub async fn close_room(state: &SharedState, channel_id: Uuid) {
    let plot_index =
        sqlx::query_scalar::<_, i32>("SELECT plot_index FROM garden_rooms WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
            .unwrap_or(0);
    let (door_x, door_y) = plot_door(plot_index);
    let peers: Vec<(GardenPeer, GardenPeer)> = {
        let mut guard = state.garden.peers.lock().unwrap();
        guard
            .values_mut()
            .filter(|peer| peer.channel_id == Some(channel_id))
            .map(|peer| {
                let old = peer.clone();
                peer.set_space(GardenSpace::Hub, door_x, door_y + 2.0);
                (old, peer.clone())
            })
            .collect()
    };
    for (old, current) in peers {
        broadcast_left(state, &old, &GardenSpace::Room(channel_id)).await;
        state
            .hub
            .broadcast(
                envelope(
                    "garden.space_changed",
                    json!({ "space": "hub", "peer": current }),
                ),
                vec![old.user_id],
            )
            .await;
        broadcast_joined(state, &current).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{clamped_for_space, plot_door, valid_facing, GardenSpace};
    use uuid::Uuid;

    #[test]
    fn plot_doors_are_stable_and_expand_in_rows() {
        assert_eq!(plot_door(0), (14.0, 19.0));
        assert_eq!(plot_door(3), (86.0, 19.0));
        assert_eq!(plot_door(4), (14.0, 38.0));
    }

    #[test]
    fn movement_clamps_to_each_scene() {
        assert_eq!(
            clamped_for_space(&GardenSpace::Hub, -10.0, 200.0),
            (2.0, 200.0)
        );
        assert_eq!(
            clamped_for_space(&GardenSpace::Room(Uuid::nil()), -4.0, 99.0),
            (2.0, 22.0)
        );
    }

    #[test]
    fn facing_is_allowlisted() {
        assert!(valid_facing("left"));
        assert!(!valid_facing("north-west"));
    }
}
