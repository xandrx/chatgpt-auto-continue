mod mcp;
mod mcp_operator;
use axum::{
    extract::Request,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chatgpt_session_dispatcher::{digest, now, same_digest, Client, Error, Store};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{env, path::PathBuf, time::Duration};

#[derive(Clone)]
struct App {
    store: Store,
    operator_digest: String,
    enroll_digest: Option<String>,
    extension_origin: Option<String>,
}

struct ApiError(Error);
impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        Self(error)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self.0 {
            Error::Invalid(field) => (StatusCode::BAD_REQUEST, field),
            Error::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Error::NotFound => (StatusCode::NOT_FOUND, "not found"),
            Error::Conflict(reason) => (StatusCode::CONFLICT, reason),
            Error::Database(_) => {
                // Never log SQL parameters, prompts or credentials.
                tracing::error!("database operation failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "database error")
            }
        };
        (status, Json(json!({"error":message}))).into_response()
    }
}
type ApiResult<T> = Result<T, ApiError>;

fn bearer(headers: &HeaderMap) -> ApiResult<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty() && v.len() <= 512)
        .ok_or(ApiError(Error::Unauthorized))
}
fn session_auth(headers: &HeaderMap, session_id: &str) -> ApiResult<String> {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty() && v.len() <= 512)
    {
        return Ok(value.to_owned());
    }
    let cookie_name = format!("csd_session_{session_id}");
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|part| {
                let (name, value) = part.trim().split_once('=')?;
                (name == cookie_name).then_some(value)
            })
        })
        .filter(|v| !v.is_empty() && v.len() <= 512)
        .map(str::to_owned)
        .ok_or(ApiError(Error::Unauthorized))
}
fn operator(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    if !same_digest(&app.operator_digest, &digest(bearer(headers)?)) {
        return Err(ApiError(Error::Unauthorized));
    }
    Ok(())
}
async fn no_cache(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
async fn extension_cors(
    State(allowed_origin): State<Option<String>>,
    request: Request,
    next: Next,
) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let allowed = allowed_origin
        .as_deref()
        .is_some_and(|expected| Some(expected) == origin.as_deref());
    if request.method().as_str() == "OPTIONS" {
        if !allowed {
            return StatusCode::FORBIDDEN.into_response();
        }
        let mut response = StatusCode::NO_CONTENT.into_response();
        let headers = response.headers_mut();
        headers.insert(
            "access-control-allow-origin",
            HeaderValue::from_str(origin.as_deref().unwrap()).unwrap(),
        );
        headers.insert(
            "access-control-allow-credentials",
            HeaderValue::from_static("true"),
        );
        headers.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        headers.insert(
            "access-control-allow-headers",
            HeaderValue::from_static("content-type, authorization"),
        );
        headers.insert("access-control-max-age", HeaderValue::from_static("600"));
        headers.insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        return response;
    }
    let mut response = next.run(request).await;
    if allowed {
        let headers = response.headers_mut();
        headers.insert(
            "access-control-allow-origin",
            HeaderValue::from_str(origin.as_deref().unwrap()).unwrap(),
        );
        headers.insert(
            "access-control-allow-credentials",
            HeaderValue::from_static("true"),
        );
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enroll {
    chat_id: String,
    alias: String,
    #[serde(default)]
    export_allowed: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enqueue {
    request_id: String,
    session_id: String,
    prompt: String,
    ttl_seconds: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientRequest {
    chat_id: String,
    worker: String,
    epoch: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitRequest {
    chat_id: String,
    worker: String,
    epoch: i64,
    wait_ms: u64,
}
impl ClientRequest {
    fn client(self, session_id: String) -> Client {
        Client {
            session_id,
            chat_id: self.chat_id,
            worker: self.worker,
            epoch: self.epoch,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Heartbeat {
    chat_id: String,
    worker: String,
    epoch: i64,
    status: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ack {
    chat_id: String,
    worker: String,
    epoch: i64,
    request_id: String,
    state: String,
    #[serde(default)]
    result: String,
}

async fn health() -> Json<Value> {
    Json(json!({"ok":true,"protocol":1,"version":env!("CARGO_PKG_VERSION")}))
}
async fn enroll(
    State(app): State<App>,
    headers: HeaderMap,
    Json(req): Json<Enroll>,
) -> ApiResult<Json<Value>> {
    operator(&app, &headers)?;
    let enrolled = app
        .store
        .enroll(&req.chat_id, &req.alias, req.export_allowed, now())
        .await?;
    Ok(Json(json!(enrolled)))
}
async fn client_enroll(
    State(app): State<App>,
    headers: HeaderMap,
    Json(req): Json<Enroll>,
) -> ApiResult<Response> {
    let token_authorized = match (app.enroll_digest.as_deref(), bearer(&headers)) {
        (Some(expected), Ok(value)) => same_digest(expected, &digest(value)),
        _ => false,
    };
    let origin_authorized = app.extension_origin.as_deref().is_some_and(|expected| {
        headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            == Some(expected)
    });
    if !token_authorized && !origin_authorized {
        return Err(ApiError(Error::Unauthorized));
    }
    let enrolled = app
        .store
        .enroll(&req.chat_id, &req.alias, req.export_allowed, now())
        .await?;
    let session_id = enrolled.session.id.clone();
    let cookie_name = format!("csd_session_{session_id}");
    let cookie = format!(
        "{cookie_name}={}; Path=/v1/sessions/{session_id}; HttpOnly; Secure; SameSite=None; Max-Age=31536000",
        enrolled.credential
    );
    let mut response = Json(json!({"session":enrolled.session})).into_response();
    let value = HeaderValue::from_bytes(cookie.as_bytes())
        .map_err(|_| ApiError(Error::Invalid("session cookie")))?;
    response.headers_mut().append(header::SET_COOKIE, value);
    Ok(response)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionQuery {
    #[serde(default)]
    after: String,
    limit: Option<u32>,
}
async fn list(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<SessionQuery>,
) -> ApiResult<Json<Value>> {
    operator(&app, &headers)?;
    Ok(Json(json!(
        app.store
            .list_page(&query.after, query.limit.unwrap_or(200), now())
            .await?
    )))
}
async fn revoke(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    operator(&app, &headers)?;
    app.store.revoke(&id, now()).await?;
    Ok(Json(json!({"ok":true})))
}
async fn enqueue(
    State(app): State<App>,
    headers: HeaderMap,
    Json(req): Json<Enqueue>,
) -> ApiResult<Json<Value>> {
    operator(&app, &headers)?;
    Ok(Json(json!(
        app.store
            .enqueue(
                &req.request_id,
                &req.session_id,
                &req.prompt,
                req.ttl_seconds,
                now()
            )
            .await?
    )))
}
async fn job(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    operator(&app, &headers)?;
    Ok(Json(json!(app.store.job(&id, now()).await?)))
}
async fn cancel(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    operator(&app, &headers)?;
    Ok(Json(json!(app.store.cancel(&id, now()).await?)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resolve {
    outcome: String,
    note: String,
    verified: bool,
}
async fn resolve(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<Resolve>,
) -> ApiResult<Json<Value>> {
    operator(&app, &headers)?;
    if !req.verified {
        return Err(ApiError(Error::Invalid("explicit verification required")));
    }
    let job = app
        .store
        .resolve(&id, &req.outcome, &req.note, now())
        .await?;
    Ok(Json(
        json!({"job":job,"review":app.store.review(&id).await?}),
    ))
}
async fn get_review(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    operator(&app, &headers)?;
    Ok(Json(json!({"review":app.store.review(&id).await?})))
}
async fn heartbeat(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<Heartbeat>,
) -> ApiResult<Json<Value>> {
    let session_key = session_auth(&headers, &id)?;
    let client = Client {
        session_id: id,
        chat_id: req.chat_id,
        worker: req.worker,
        epoch: req.epoch,
    };
    Ok(Json(json!(
        app.store
            .heartbeat(&client, &session_key, &req.status, now())
            .await?
    )))
}
async fn claim(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<ClientRequest>,
) -> ApiResult<Json<Value>> {
    let session_key = session_auth(&headers, &id)?;
    Ok(Json(
        json!({"job":app.store.claim(&req.client(id), &session_key, now()).await?}),
    ))
}
async fn wait(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<WaitRequest>,
) -> ApiResult<Json<Value>> {
    let session_key = session_auth(&headers, &id)?;
    let client = Client {
        session_id: id,
        chat_id: req.chat_id,
        worker: req.worker,
        epoch: req.epoch,
    };
    Ok(Json(
        json!({"job":app.store.claim_wait(&client, &session_key, req.wait_ms).await?}),
    ))
}
async fn ack(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<Ack>,
) -> ApiResult<Json<Value>> {
    let session_key = session_auth(&headers, &id)?;
    let client = Client {
        session_id: id,
        chat_id: req.chat_id,
        worker: req.worker,
        epoch: req.epoch,
    };
    Ok(Json(json!(
        app.store
            .ack(
                &client,
                &session_key,
                &req.request_id,
                &req.state,
                &req.result,
                now()
            )
            .await?
    )))
}
fn router(app: App) -> Router {
    let extension_origin = app.extension_origin.clone();
    Router::new()
        .route("/health", get(health))
        .route("/v1/sessions", get(list).post(enroll))
        .route("/v1/client/enroll", post(client_enroll))
        .route("/v1/sessions/{id}/revoke", post(revoke))
        .route("/v1/sessions/{id}/heartbeat", post(heartbeat))
        .route("/v1/sessions/{id}/claim", post(claim))
        .route("/v1/sessions/{id}/wait", post(wait))
        .route("/v1/sessions/{id}/ack", post(ack))
        .route("/v1/jobs", post(enqueue))
        .route("/v1/jobs/{id}", get(job))
        .route("/v1/jobs/{id}/cancel", post(cancel))
        .route("/v1/jobs/{id}/review", get(get_review).post(resolve))
        .layer(DefaultBodyLimit::max(512 * 1024))
        .layer(middleware::from_fn_with_state(
            extension_origin,
            extension_cors,
        ))
        .layer(middleware::from_fn(no_cache))
        .with_state(app)
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use tower::ServiceExt;
    async fn call(
        app: &Router,
        method: &str,
        path: &str,
        auth: Option<&str>,
        payload: Value,
    ) -> (StatusCode, Value) {
        let mut builder = axum::http::Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(value) = auth {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {value}"));
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::from(payload.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .unwrap()
                .to_str()
                .unwrap(),
            "no-store"
        );
        let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        (status, value)
    }
    #[test]
    fn session_cookie_is_scoped_to_its_session_path() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("csd_session_alpha=key-a; csd_session_beta=key-b"),
        );
        assert_eq!(
            session_auth(&headers, "alpha").ok().as_deref(),
            Some("key-a")
        );
        assert_eq!(
            session_auth(&headers, "beta").ok().as_deref(),
            Some("key-b")
        );
        assert!(session_auth(&headers, "gamma").is_err());
    }

    #[tokio::test]
    async fn client_enrollment_returns_session_metadata_not_a_bearer_key() {
        let directory =
            std::env::temp_dir().join(format!("csd-enroll-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let store = Store::open(&directory.join("enroll.sqlite3"))
            .await
            .unwrap();
        let admin = uuid::Uuid::new_v4().to_string();
        let enrollment = uuid::Uuid::new_v4().to_string();
        let app = router(App {
            store,
            operator_digest: digest(&admin),
            enroll_digest: Some(digest(&enrollment)),
            extension_origin: None,
        });
        let payload = json!({"chat_id":"client-chat","alias":"Client tab"});
        let (status, _) = call(&app, "POST", "/v1/client/enroll", None, payload.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = call(
            &app,
            "POST",
            "/v1/client/enroll",
            Some(&admin),
            payload.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, enrolled) = call(
            &app,
            "POST",
            "/v1/client/enroll",
            Some(&enrollment),
            payload.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(enrolled["session"]["id"].is_string());
        assert!(enrolled.get("credential").is_none());
        drop(app);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn api_auth_scope_and_job_lifecycle() {
        let directory = std::env::temp_dir().join(format!("csd-api-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("api.sqlite3");
        let store = Store::open(&path).await.unwrap();
        let operator_key = uuid::Uuid::new_v4().to_string();
        let app = router(App {
            store,
            operator_digest: digest(&operator_key),
            enroll_digest: None,
            extension_origin: None,
        });
        let (status, _) = call(&app, "GET", "/health", None, Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = call(&app, "GET", "/v1/sessions", None, Value::Null).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, enrolled) = call(
            &app,
            "POST",
            "/v1/sessions",
            Some(&operator_key),
            json!({"chat_id":"fixture-chat","alias":"Test"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let sid = enrolled["session"]["id"].as_str().unwrap();
        let session_key = enrolled["credential"].as_str().unwrap();
        let (status, _) = call(&app, "GET", "/v1/sessions", Some(session_key), Value::Null).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, listed) = call(
            &app,
            "GET",
            "/v1/sessions",
            Some(&operator_key),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!listed.to_string().contains(session_key));
        assert!(!listed.to_string().contains("credential_hash"));
        let prefix = format!("/v1/sessions/{sid}");
        let (status, _) = call(
            &app,
            "POST",
            &format!("{prefix}/heartbeat"),
            Some(session_key),
            json!({"chat_id":"different","worker":"test","epoch":0,"status":"idle"}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, lease) = call(
            &app,
            "POST",
            &format!("{prefix}/heartbeat"),
            Some(session_key),
            json!({"chat_id":"fixture-chat","worker":"test","epoch":0,"status":"idle"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let epoch = lease["epoch"].as_i64().unwrap();
        let (status, _) = call(
            &app,
            "POST",
            "/v1/jobs",
            Some(&operator_key),
            json!({"request_id":"r1","session_id":sid,"prompt":"fixture task","ttl_seconds":600}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = call(
            &app,
            "POST",
            &format!("{prefix}/wait"),
            Some(session_key),
            json!({"chat_id":"fixture-chat","worker":"test","epoch":epoch,"wait_ms":25001}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, claimed) = call(
            &app,
            "POST",
            &format!("{prefix}/wait"),
            Some(session_key),
            json!({"chat_id":"fixture-chat","worker":"test","epoch":epoch,"wait_ms":100}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(claimed["job"]["id"], "r1");
        let (status, _) = call(&app,"POST",&format!("{prefix}/ack"),Some(session_key),json!({"chat_id":"fixture-chat","worker":"test","epoch":epoch,"request_id":"r1","state":"completed"})).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _) = call(&app,"POST",&format!("{prefix}/ack"),Some(session_key),json!({"chat_id":"fixture-chat","worker":"test","epoch":epoch,"request_id":"r1","state":"submitted"})).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = call(&app,"POST",&format!("{prefix}/ack"),Some(session_key),json!({"chat_id":"fixture-chat","worker":"test","epoch":epoch,"request_id":"r1","state":"completed","result":"not allowed"})).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _) = call(&app,"POST",&format!("{prefix}/ack"),Some(session_key),json!({"chat_id":"fixture-chat","worker":"test","epoch":epoch,"request_id":"r1","state":"completed"})).await;
        assert_eq!(status, StatusCode::OK);
        let (status, job) =
            call(&app, "GET", "/v1/jobs/r1", Some(&operator_key), Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(job["state"], "completed");
        let (status, _) = call(
            &app,
            "POST",
            "/v1/jobs/r1/review",
            Some(session_key),
            json!({"outcome":"completed","note":"fixture","verified":true}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = call(
            &app,
            "POST",
            "/v1/jobs/r1/review",
            Some(&operator_key),
            json!({"outcome":"completed","note":"fixture","verified":false}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = call(
            &app,
            "POST",
            "/v1/jobs/r1/review",
            Some(&operator_key),
            json!({"outcome":"completed","note":"fixture","verified":true}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, empty) = call(
            &app,
            "POST",
            &format!("{prefix}/wait"),
            Some(session_key),
            json!({"chat_id":"fixture-chat","worker":"test","epoch":epoch,"wait_ms":10}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(empty["job"].is_null());
        drop(app);
        // SQLite's worker may close asynchronously; keep temp cleanup best effort on Windows.
        let _ = std::fs::remove_dir_all(directory);
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_target(false).init();
    let credential = env::var("DISPATCHER_ADMIN_TOKEN")
        .map_err(|_| std::io::Error::other("DISPATCHER_ADMIN_TOKEN is required"))?;
    if credential.len() < 32 || credential.len() > 512 {
        return Err(std::io::Error::other("operator credential must contain 32–512 bytes").into());
    }
    let path =
        PathBuf::from(env::var_os("DISPATCHER_DB").unwrap_or_else(|| "dispatcher.sqlite3".into()));
    // Bind first so a second local process cannot invalidate an active server's leases.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8766").await?;
    let store = Store::open(&path)
        .await
        .map_err(|_| std::io::Error::other("cannot initialize database"))?;
    let enroll_digest = match env::var("DISPATCHER_ENROLL_TOKEN") {
        Ok(value)
            if value.len() >= 32
                && value.len() <= 512
                && !same_digest(&digest(&value), &digest(&credential)) =>
        {
            Some(digest(&value))
        }
        Ok(_) => {
            return Err(std::io::Error::other(
                "enrollment credential must be 32–512 bytes and distinct from admin credential",
            )
            .into())
        }
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err(std::io::Error::other("invalid enrollment credential").into()),
    };
    let extension_origin = match env::var("DISPATCHER_EXTENSION_ORIGIN") {
        Ok(value) => {
            let id = value.strip_prefix("chrome-extension://").unwrap_or("");
            if id.len() != 32 || !id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)) {
                return Err(std::io::Error::other(
                    "DISPATCHER_EXTENSION_ORIGIN must be chrome-extension:// followed by a 32-character extension ID",
                ).into());
            }
            Some(value)
        }
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err(std::io::Error::other("invalid extension origin").into()),
    };
    let retry_store = store.clone();
    tokio::spawn(async move {
        loop {
            if retry_store.process_retries(now()).await.is_err() {
                tracing::error!("dispatcher retry scheduler tick failed");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    let app = App {
        store,
        operator_digest: digest(&credential),
        enroll_digest,
        extension_origin,
    };
    let observer = match env::var("DISPATCHER_OBSERVER_TOKEN") {
        Ok(value)
            if value.len() >= 32
                && value.len() <= 512
                && !same_digest(&digest(&value), &app.operator_digest)
                && app.enroll_digest.as_ref().is_none_or(|scope| !same_digest(scope, &digest(&value))) =>
        {
            Some(digest(&value))
        }
        Ok(_) => {
            return Err(std::io::Error::other(
                "observer credential must be 32–512 bytes and distinct from admin/enrollment credentials",
            )
            .into())
        }
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err(std::io::Error::other("invalid observer credential").into()),
    };
    let mcp_operator = match env::var("DISPATCHER_MCP_OPERATOR_TOKEN") {
        Ok(value)
            if value.len() >= 32
                && value.len() <= 512
                && !same_digest(&digest(&value), &app.operator_digest)
                && observer.as_ref().is_none_or(|scope| !same_digest(scope, &digest(&value)))
                && app.enroll_digest.as_ref().is_none_or(|scope| !same_digest(scope, &digest(&value))) =>
        {
            Some(digest(&value))
        }
        Ok(_) => {
            return Err(std::io::Error::other(
                "MCP operator credential must be 32–512 bytes and distinct from admin and observer credentials",
            )
            .into())
        }
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err(std::io::Error::other("invalid MCP operator credential").into()),
    };
    drop(credential);
    let mut routes = router(app.clone());
    if let Some(scope) = observer {
        routes = routes.merge(mcp::routes(app.store.clone(), scope));
    }
    if let Some(scope) = mcp_operator {
        routes = routes.merge(mcp_operator::routes(app.store.clone(), scope));
    }
    tracing::info!("dispatcher development API listening on loopback");
    axum::serve(listener, routes).await?;
    Ok(())
}
