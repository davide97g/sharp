use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::state::SharedState;
use axum::extract::State;
use axum::Json;
use serde_json::json;

pub async fn voice_config(
    State(state): State<SharedState>,
    _auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let mut ice_servers = vec![json!({ "urls": state.config.ice.stun_urls })];
    if let Some(turn) = &state.config.ice.turn {
        ice_servers.push(json!({
            "urls": [turn.url.clone()],
            "username": turn.username,
            "credential": turn.password,
        }));
    }

    Ok(Json(json!({ "ice_servers": ice_servers })))
}
