use std::env;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub port: u16,
    pub redis_url: Option<String>,
    pub web_dist: String,
    pub disable_signup: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let database_url =
            env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required".to_string())?;
        let jwt_secret =
            env::var("JWT_SECRET").map_err(|_| "JWT_SECRET is required".to_string())?;
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(3000);
        let redis_url = env::var("REDIS_URL").ok().filter(|s| !s.is_empty());
        let web_dist = env::var("WEB_DIST").unwrap_or_else(|_| "./web-dist".to_string());
        let disable_signup = env::var("SHARP_DISABLE_SIGNUP")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        Ok(Config {
            database_url,
            jwt_secret,
            port,
            redis_url,
            web_dist,
            disable_signup,
        })
    }
}
