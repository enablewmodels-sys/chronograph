use crate::{ApiError, AppResult};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use rand::TryRngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn secret() -> String {
    let mut b = [0u8; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut b)
        .expect("OS entropy unavailable");
    hex(&b)
}
pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
pub fn hash(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}
pub fn equal(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}
fn encode(raw: &str) -> AppResult<String> {
    let salt = SaltString::encode_b64(&Sha256::digest(secret().as_bytes())[..16])
        .map_err(ApiError::internal)?;
    Argon2::default()
        .hash_password(raw.as_bytes(), &salt)
        .map(|p| p.to_string())
        .map_err(ApiError::internal)
}
pub fn verify(raw: &str, encoded: &str) -> bool {
    raw.len() == 84
        && PasswordHash::new(encoded).is_ok_and(|h| {
            Argon2::default()
                .verify_password(raw.as_bytes(), &h)
                .is_ok()
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Read,
    Ingest,
    Admin,
}
#[derive(Clone)]
pub struct Principal {
    pub id: String,
    pub scope: Scope,
}
impl Principal {
    pub fn authorize(&self, op: &str) -> AppResult<()> {
        let admin = matches!(
            op,
            "backup"
                | "backups"
                | "delete_backup"
                | "tokens"
                | "create_token"
                | "revoke_token"
                | "load_demo"
                | "schema_apply"
        );
        if (admin && self.scope != Scope::Admin)
            || (crate::operations::is_write(op) && self.scope == Scope::Read)
        {
            return Err(ApiError::forbidden());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Token {
    pub id: String,
    pub name: String,
    pub scope: Scope,
    pub expires_at: u64,
    pub created_at: u64,
    pub argon2id: String,
}
impl Token {
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({"id":self.id,"name":self.name,"scope":self.scope,"expires_at":self.expires_at,"created_at":self.created_at})
    }
    pub fn generate(name: &str, scope: Scope, days: u64) -> AppResult<(Self, String)> {
        if name.trim().is_empty() || name.len() > 80 || !(1..=365).contains(&days) {
            return Err(ApiError::bad(
                "Provide a name (1–80 bytes) and expiry of 1–365 days",
            ));
        }
        let id = secret()[..16].to_owned();
        let raw = format!("cg_{id}_{}", secret());
        Ok((
            Self {
                id,
                name: name.trim().into(),
                scope,
                created_at: now(),
                expires_at: now() + days * 86400,
                argon2id: encode(&raw)?,
            },
            raw,
        ))
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub version: u32,
    pub tokens: Vec<Token>,
}
pub struct Auth {
    pub credentials: Credentials,
    path: PathBuf,
    _lock: fs::File,
    cache: HashMap<String, String>,
    attempts: VecDeque<u64>,
    requests: HashMap<String, (u64, u32)>,
    failed: bool,
}
pub enum Verification {
    Cached(Principal),
    Hash(Token),
}

pub fn private_dir(path: &Path) -> AppResult<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub fn check_private_file(path: &Path) -> AppResult<()> {
    let m = fs::symlink_metadata(path)?;
    if !m.is_file() {
        return Err(ApiError::bad(
            "Credential path must be a regular file, not a symlink",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if m.permissions().mode() & 0o077 != 0 {
            return Err(ApiError::bad(
                "Credential files must be private (chmod 600)",
            ));
        }
    }
    Ok(())
}
pub fn write_new_private(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::File::open(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?
    .sync_all()?;
    Ok(())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension(format!("pending-{}", secret()));
    let result = (|| {
        write_new_private(&tmp, bytes)?;
        fs::rename(&tmp, path)?;
        fs::File::open(path.parent().unwrap())?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
impl Auth {
    pub fn open(path: &Path, create: bool) -> AppResult<Self> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        if create {
            private_dir(parent)?;
        }
        let path = parent.canonicalize()?.join(
            path.file_name()
                .ok_or_else(|| ApiError::bad("Auth path must name a file"))?,
        );
        let lock_path = path.with_extension("lock");
        if lock_path.exists() {
            check_private_file(&lock_path)?;
        }
        let mut opts = fs::OpenOptions::new();
        opts.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let lock = opts.open(lock_path)?;
        lock.try_lock().map_err(|_| {
            ApiError::conflict(
                "Credential store is locked; stop the service before using offline admin commands",
            )
        })?;
        if !path.exists() && create {
            write_new_private(
                &path,
                &serde_json::to_vec_pretty(&Credentials {
                    version: 2,
                    tokens: vec![],
                })
                .map_err(ApiError::internal)?,
            )?;
        }
        check_private_file(&path)?;
        let bytes = fs::read(&path)?;
        let v: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("Invalid credential file"))?;
        if v["version"] != 2 {
            return Err(ApiError::bad(
                "Legacy credentials cannot be converted: keep the old file and create new scoped tokens in a separate config/auth.json",
            ));
        }
        let credentials: Credentials =
            serde_json::from_value(v).map_err(|_| ApiError::bad("Invalid credential schema"))?;
        let mut ids = std::collections::HashSet::new();
        if credentials.tokens.len() > 100
            || credentials.tokens.iter().any(|t| {
                !valid_id(&t.id)
                    || !ids.insert(&t.id)
                    || t.name.is_empty()
                    || t.name.len() > 80
                    || t.expires_at <= t.created_at
                    || !PasswordHash::new(&t.argon2id).is_ok_and(|h| {
                        h.algorithm.as_str() == "argon2id"
                            && h.params.get_decimal("m") == Some(19456)
                            && h.params.get_decimal("t") == Some(2)
                            && h.params.get_decimal("p") == Some(1)
                    })
            })
        {
            return Err(ApiError::bad(
                "Invalid token record or unsupported Argon2id parameters",
            ));
        }
        Ok(Self {
            credentials,
            path,
            _lock: lock,
            cache: HashMap::new(),
            attempts: VecDeque::new(),
            requests: HashMap::new(),
            failed: false,
        })
    }
    fn active(&self, id: &str) -> Option<&Token> {
        self.credentials
            .tokens
            .iter()
            .find(|t| t.id == id && t.expires_at > now())
    }
    pub fn begin(&mut self, raw: &str) -> AppResult<Verification> {
        if self.failed {
            return Err(ApiError::unavailable(
                "Credential persistence failed; restart after inspecting the store",
            ));
        }
        let n = now();
        let token = token_id(raw).and_then(|id| self.active(id)).cloned();
        if let Some(t) = &token
            && self.cache.get(&t.id).is_some_and(|d| equal(d, &hash(raw)))
        {
            return Ok(Verification::Cached(self.principal(t)?));
        }
        while self
            .attempts
            .front()
            .is_some_and(|t| n.saturating_sub(*t) >= 60)
        {
            self.attempts.pop_front();
        }
        if self.attempts.len() >= 120 {
            return Err(ApiError::rate_limited());
        }
        self.attempts.push_back(n);
        token
            .map(Verification::Hash)
            .ok_or_else(ApiError::unauthorized)
    }
    pub fn finish(&mut self, token: &Token, raw: &str, verified: bool) -> AppResult<Principal> {
        if self.failed
            || !verified
            || !self
                .active(&token.id)
                .is_some_and(|t| equal(&t.argon2id, &token.argon2id))
        {
            return Err(ApiError::unauthorized());
        }
        self.cache.insert(token.id.clone(), hash(raw));
        self.principal(token)
    }
    fn principal(&mut self, t: &Token) -> AppResult<Principal> {
        let bucket = self.requests.entry(t.id.clone()).or_insert((now(), 0));
        if now().saturating_sub(bucket.0) >= 60 {
            *bucket = (now(), 0);
        }
        if bucket.1 >= 12_000 {
            return Err(ApiError::rate_limited());
        }
        bucket.1 += 1;
        Ok(Principal {
            id: t.id.clone(),
            scope: t.scope,
        })
    }
    pub fn insert(&mut self, token: Token) -> AppResult<()> {
        if self.credentials.tokens.len() >= 100 {
            return Err(ApiError::bad("Token limit reached; revoke unused tokens"));
        }
        let mut c = self.credentials.clone();
        c.tokens.push(token);
        self.save(c)
    }
    pub fn revoke(&mut self, id: &str) -> AppResult<()> {
        let mut c = self.credentials.clone();
        c.tokens.retain(|t| t.id != id);
        self.save(c)
    }
    fn save(&mut self, c: Credentials) -> AppResult<()> {
        if self.failed {
            return Err(ApiError::unavailable(
                "Credential writer failed; reopen before retrying",
            ));
        }
        if let Err(e) = atomic_write(
            &self.path,
            &serde_json::to_vec_pretty(&c).map_err(ApiError::internal)?,
        ) {
            self.failed = true;
            return Err(e);
        }
        self.credentials = c;
        self.cache.clear();
        self.requests
            .retain(|id, _| self.credentials.tokens.iter().any(|t| &t.id == id));
        Ok(())
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn token_id(raw: &str) -> Option<&str> {
    if raw.len() != 84
        || !raw.is_ascii()
        || !raw.starts_with("cg_")
        || raw.as_bytes()[19] != b'_'
        || !valid_id(&raw[3..19])
        || !raw[20..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        None
    } else {
        Some(&raw[3..19])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn salted_tokens_cache_revocation_expiry_and_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let mut a = Auth::open(&path, true).unwrap();
        assert!(Auth::open(&path, false).is_err());
        let (t, raw) = Token::generate("reader", Scope::Read, 1).unwrap();
        assert!(verify(&raw, &t.argon2id));
        assert!(!verify(&"x".repeat(84), &t.argon2id));
        a.insert(t.clone()).unwrap();
        assert!(!fs::read_to_string(&path).unwrap().contains(&raw));
        assert!(matches!(a.begin(&raw).unwrap(), Verification::Hash(_)));
        let p = a.finish(&t, &raw, true).unwrap();
        assert!(p.authorize("as_of").is_ok());
        assert!(p.authorize("add_edges").is_err());
        assert!(p.authorize("backup").is_err());
        assert!(matches!(a.begin(&raw).unwrap(), Verification::Cached(_)));
        a.credentials.tokens[0].expires_at = now();
        assert!(a.begin(&raw).is_err());
        a.credentials.tokens[0].expires_at = now() + 60;
        a.revoke(&t.id).unwrap();
        assert!(a.finish(&t, &raw, true).is_err());
        assert!(a.begin(&raw).is_err());
        drop(a);
        assert!(
            Auth::open(&path, false)
                .unwrap()
                .credentials
                .tokens
                .is_empty()
        );
    }
    #[test]
    fn malformed_credentials_and_commit_failure_fail_closed() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("auth.json");
        let mut a = Auth::open(&path, true).unwrap();
        let (t, raw) = Token::generate("admin", Scope::Admin, 1).unwrap();
        a.insert(t.clone()).unwrap();
        a.path = d.path().join("absent/auth.json");
        assert!(a.revoke(&t.id).is_err());
        assert_eq!(a.credentials.tokens.len(), 1);
        assert!(a.begin(&raw).is_err());
        drop(a);
        let a = Auth::open(&path, false).unwrap();
        assert_eq!(a.credentials.tokens.len(), 1);
        drop(a);
        atomic_write(&path, b"{\"version\":1}").unwrap();
        assert!(Auth::open(&path, false).is_err());
    }
    #[test]
    fn rate_limits_invalid_credentials_before_expensive_hashing() {
        let d = tempfile::tempdir().unwrap();
        let mut a = Auth::open(&d.path().join("auth.json"), true).unwrap();
        for _ in 0..120 {
            assert_eq!(
                a.begin("bad").err().unwrap().0,
                axum::http::StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            a.begin("bad").err().unwrap().0,
            axum::http::StatusCode::TOO_MANY_REQUESTS
        );
        assert!(Token::generate("x", Scope::Read, 0).is_err());
    }
}
