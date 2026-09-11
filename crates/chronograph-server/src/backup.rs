//! Portable, checksummed backups. Credentials and unrelated workspace files are excluded.
use crate::{ApiError, AppResult, auth};
use chronograph_db::Graph;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufWriter, Read, Write},
    path::{Component, Path, PathBuf},
};
const MAX_FILES: usize = 10_000;
const MAX_TOTAL: u64 = 100 * 1024 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    bytes: u64,
    sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: u32,
    journal_format: u32,
    revision: String,
    created_at: u64,
    files: Vec<Entry>,
}
pub fn path(data: &Path, id: &str) -> AppResult<PathBuf> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::bad("Invalid backup ID"));
    }
    Ok(data.join("backups").join(format!("{id}.tar")))
}
pub fn list(data: &Path) -> AppResult<Vec<Value>> {
    let dir = data.join("backups");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for e in fs::read_dir(dir)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".tar") {
            if path(data, id).is_err() || !e.file_type()?.is_file() {
                continue;
            }
            let m = e.metadata()?;
            out.push(json!({"id":id,"bytes":m.len().to_string(),"created_at":m.modified()?.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()}));
        }
    }
    out.sort_by_key(|v| std::cmp::Reverse(v["created_at"].as_u64()));
    Ok(out)
}
fn checksum(path: &Path) -> AppResult<String> {
    let mut f = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(auth::hex(&hash.finalize()))
}
fn collect(base: &Path, dir: &Path, paths: &mut Vec<PathBuf>) -> AppResult<()> {
    for e in fs::read_dir(dir)? {
        let e = e?;
        let ty = e.file_type()?;
        if ty.is_symlink() {
            return Err(ApiError::bad("Owned sidecars cannot contain symlinks"));
        }
        if ty.is_dir() {
            collect(base, &e.path(), paths)?;
        } else if ty.is_file() {
            paths.push(
                e.path()
                    .strip_prefix(base)
                    .map_err(ApiError::internal)?
                    .to_owned(),
            );
            if paths.len() > MAX_FILES {
                return Err(ApiError::bad("Backup is limited to 10000 files"));
            }
        } else {
            return Err(ApiError::bad("Owned sidecars must be regular files"));
        }
    }
    Ok(())
}
fn snapshot(g: &Graph, path: &Path) -> AppResult<()> {
    let file = File::create(path)?;
    let mut out = BufWriter::new(file);
    out.write_all(b"CGIX0001")?;
    for n in [
        g.revision(),
        g.stats().nodes as u64,
        g.stats().edge_versions as u64,
    ] {
        out.write_all(&n.to_le_bytes())?;
    }
    for n in g.nodes() {
        out.write_all(&n.0.to_le_bytes())?;
    }
    for e in g.history() {
        for n in [e.id.0, e.src.0, e.dst.0] {
            out.write_all(&n.to_le_bytes())?;
        }
        out.write_all(&e.kind.0.to_le_bytes())?;
        out.write_all(&e.valid_from.to_le_bytes())?;
        out.write_all(&e.valid_to.to_le_bytes())?;
        out.write_all(&e.payload)?;
    }
    out.flush()?;
    out.get_ref().sync_all()?;
    Ok(())
}
/// Caller must hold the graph's write lock for the entire capture.
pub fn create(g: &mut Graph, data: &Path) -> AppResult<Value> {
    if list(data)?.len() >= 3 {
        return Err(ApiError::bad(
            "At most 3 local backups; download and remove an older backup first",
        ));
    }
    g.sync()?;
    auth::private_dir(&data.join("backups"))?;
    let id = auth::secret();
    let dest = path(data, &id)?;
    let stage = data.join("backups").join(format!(".pending-{id}"));
    auth::private_dir(&stage)?;
    let tmp = dest.with_extension("pending");
    let result = (|| {
        fs::copy(data.join("graph.cgraph"), stage.join("graph.cgraph"))?;
        snapshot(g, &stage.join("index.snapshot"))?;
        let mut paths = vec![
            PathBuf::from("graph.cgraph"),
            PathBuf::from("index.snapshot"),
        ];
        crate::schema::Catalog::open(data)?;
        if data.join("schema.json").exists() {
            fs::copy(data.join("schema.json"), stage.join("schema.json"))?;
            paths.push(PathBuf::from("schema.json"));
        }
        if data.join("sidecars").exists() {
            let mut sidecars = vec![];
            if fs::symlink_metadata(data.join("sidecars"))?
                .file_type()
                .is_symlink()
            {
                return Err(ApiError::bad("Owned sidecar directory cannot be a symlink"));
            }
            collect(data, &data.join("sidecars"), &mut sidecars)?;
            for p in sidecars {
                let dest = stage.join(&p);
                fs::create_dir_all(dest.parent().unwrap())?;
                fs::copy(data.join(&p), dest)?;
                paths.push(p);
            }
        }
        paths.sort();
        let mut files = vec![];
        let mut total = 0u64;
        for p in paths {
            let f = stage.join(&p);
            let bytes = fs::metadata(&f)?.len();
            total = total
                .checked_add(bytes)
                .ok_or_else(|| ApiError::bad("Backup size overflow"))?;
            if total > MAX_TOTAL || files.len() >= MAX_FILES {
                return Err(ApiError::bad("Backup exceeds 100 GiB or 10000 files"));
            }
            let name = p
                .to_str()
                .ok_or_else(|| ApiError::bad("Sidecar paths must be UTF-8"))?
                .to_owned();
            if !allowed(&name) {
                return Err(ApiError::bad("Unsupported owned sidecar path"));
            }
            files.push(Entry {
                path: name,
                bytes,
                sha256: checksum(&f)?,
            });
        }
        let manifest = Manifest {
            format: 1,
            journal_format: 3,
            revision: g.revision().to_string(),
            created_at: auth::now(),
            files,
        };
        fs::write(
            stage.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).map_err(ApiError::internal)?,
        )?;
        let file = File::create(&tmp)?;
        let mut archive = tar::Builder::new(file);
        archive.append_path_with_name(stage.join("manifest.json"), "manifest.json")?;
        for entry in &manifest.files {
            archive.append_path_with_name(stage.join(&entry.path), &entry.path)?;
        }
        let file = archive.into_inner()?;
        file.sync_all()?;
        fs::rename(&tmp, &dest)?;
        File::open(dest.parent().unwrap())?.sync_all()?;
        Ok(
            json!({"id":id,"revision":manifest.revision,"bytes":fs::metadata(&dest)?.len().to_string(),"files":manifest.files.len(),"durability":"fsync","format":1}),
        )
    })();
    let _ = fs::remove_dir_all(&stage);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
fn allowed(s: &str) -> bool {
    let p = Path::new(s);
    s.len() <= 1024
        && !s.contains('\\')
        && !s.contains('\0')
        && p.components().all(|c| matches!(c, Component::Normal(_)))
        && (s == "graph.cgraph"
            || s == "schema.json"
            || s == "index.snapshot"
            || (s.starts_with("sidecars/") && !s.ends_with('/')))
}
/// Restore into an absent or empty directory, preserving both the source and any existing data.
pub fn restore(source: &Path, dest: &Path) -> AppResult<Value> {
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    if dest.exists()
        && (fs::symlink_metadata(dest)?.file_type().is_symlink()
            || fs::read_dir(dest)?.next().is_some())
    {
        return Err(ApiError::conflict(
            "Restore destination must be absent or empty",
        ));
    }
    let stage = parent.join(format!(".chronograph-restore-{}", auth::secret()));
    auth::private_dir(&stage)?;
    let result = (|| {
        let mut archive = tar::Archive::new(File::open(source)?);
        let mut entries = archive.entries()?;
        let mut first = entries
            .next()
            .ok_or_else(|| ApiError::bad("Backup manifest missing"))??;
        if first.path()?.as_ref() != Path::new("manifest.json")
            || !first.header().entry_type().is_file()
            || first.size() > 8 * 1024 * 1024
        {
            return Err(ApiError::bad("Invalid backup manifest entry"));
        }
        let mut bytes = vec![];
        first.read_to_end(&mut bytes)?;
        let manifest: Manifest =
            serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("Invalid backup manifest"))?;
        if manifest.format != 1
            || !matches!(manifest.journal_format, 2 | 3)
            || manifest.files.len() > MAX_FILES
        {
            return Err(ApiError::bad("Unsupported backup format or file count"));
        }
        let revision: u64 = manifest
            .revision
            .parse()
            .map_err(|_| ApiError::bad("Invalid manifest revision"))?;
        let mut names = HashSet::new();
        let mut total = 0u64;
        for file in &manifest.files {
            total = total
                .checked_add(file.bytes)
                .ok_or_else(|| ApiError::bad("Backup size overflow"))?;
            if !allowed(&file.path)
                || !names.insert(file.path.clone())
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                || total > MAX_TOTAL
            {
                return Err(ApiError::bad(
                    "Invalid manifest file, duplicate path or oversized backup",
                ));
            }
        }
        if !names.contains("graph.cgraph") || !names.contains("index.snapshot") {
            return Err(ApiError::bad(
                "Backup must contain the journal and index snapshot",
            ));
        }
        for entry in entries {
            let mut entry = entry?;
            let name = entry
                .path()?
                .to_str()
                .ok_or_else(|| ApiError::bad("Invalid backup path"))?
                .to_owned();
            let meta = manifest
                .files
                .iter()
                .find(|f| f.path == name)
                .ok_or_else(|| ApiError::bad("Unlisted archive entry"))?;
            if !entry.header().entry_type().is_file()
                || !names.remove(&name)
                || entry.size() != meta.bytes
            {
                return Err(ApiError::bad(
                    "Invalid archive entry type, size or duplicate",
                ));
            }
            let path = stage.join(&name);
            fs::create_dir_all(path.parent().unwrap())?;
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)?;
            let copied = std::io::copy(&mut entry, &mut file)?;
            file.sync_all()?;
            if copied != meta.bytes || checksum(&path)? != meta.sha256 {
                return Err(ApiError::bad("Backup checksum mismatch or truncated entry"));
            }
        }
        if !names.is_empty() {
            return Err(ApiError::bad("Backup is missing declared files"));
        }
        if manifest.journal_format == 2 {
            Graph::migrate_v2(stage.join("graph.cgraph"), stage.join("graph.upgraded"))?;
            fs::rename(stage.join("graph.upgraded"), stage.join("graph.cgraph"))?;
        }
        let g = Graph::open(stage.join("graph.cgraph"))?;
        crate::schema::Catalog::open(&stage)?;
        if g.stats().recovered_tail_bytes != 0 || g.revision() != revision {
            return Err(ApiError::bad(
                "Backup journal is incomplete or has the wrong revision",
            ));
        }
        // The snapshot is a disposable logical index cache. Journal replay is authoritative.
        let mut snapshot = File::open(stage.join("index.snapshot"))?;
        let mut header = [0; 32];
        snapshot.read_exact(&mut header)?;
        let n = |i| u64::from_le_bytes(header[i..i + 8].try_into().unwrap());
        if &header[..8] != b"CGIX0001"
            || n(8) != revision
            || n(16) != g.stats().nodes as u64
            || n(24) != g.stats().edge_versions as u64
        {
            return Err(ApiError::bad("Index snapshot does not match journal"));
        }
        let result = json!({"restored":true,"revision":revision.to_string(),"nodes":g.stats().nodes.to_string(),"edge_versions":g.stats().edge_versions.to_string(),"files":manifest.files.len()});
        g.close()?;
        // Every file is synchronized; sync directories bottom-up before exposing the bundle.
        sync_dirs(&stage)?;
        if dest.exists() {
            fs::remove_dir(dest)?;
        }
        fs::rename(&stage, dest)?;
        File::open(parent)?.sync_all()?;
        Ok(result)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}
fn sync_dirs(path: &Path) -> AppResult<()> {
    for e in fs::read_dir(path)? {
        let e = e?;
        if e.file_type()?.is_dir() {
            sync_dirs(&e.path())?;
        }
    }
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chronograph_db::{EdgeKind, NodeId};
    #[test]
    fn backup_restore_sidecars_and_source_preservation() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        fs::create_dir(&data).unwrap();
        let mut g = Graph::open(data.join("graph.cgraph")).unwrap();
        g.add_node(NodeId(u64::MAX)).unwrap();
        g.add_edge(NodeId(1), NodeId(2), EdgeKind(3), -9, [7; 16])
            .unwrap();
        fs::create_dir(data.join("sidecars")).unwrap();
        fs::write(data.join("sidecars/epoch.arrow"), b"sidecar test").unwrap();
        fs::write(data.join("auth.json"), b"must not be copied").unwrap();
        let active = g.fork(0).unwrap();
        g.add_edges_to_fork(
            active,
            &[chronograph_db::EdgeInput {
                src: NodeId(1),
                dst: NodeId(2),
                kind: EdgeKind(3),
                valid_from: 10,
                payload: [9; 16],
            }],
        )
        .unwrap();
        let discarded = g.fork(0).unwrap();
        g.discard(discarded).unwrap();
        let merged = g.fork(0).unwrap();
        g.merge(merged).unwrap();
        let b = create(&mut g, &data).unwrap();
        let source = path(&data, b["id"].as_str().unwrap()).unwrap();
        let original = fs::read(&source).unwrap();
        let dest = d.path().join("restored");
        restore(&source, &dest).unwrap();
        assert!(!dest.join("auth.json").exists());
        assert_eq!(
            fs::read(dest.join("sidecars/epoch.arrow")).unwrap(),
            b"sidecar test"
        );
        let restored = Graph::open(dest.join("graph.cgraph")).unwrap();
        assert_eq!(g.history(), restored.history());
        assert_eq!(g.revision(), restored.revision());
        assert_eq!(
            g.forks().collect::<Vec<_>>(),
            restored.forks().collect::<Vec<_>>()
        );
        assert_eq!(
            g.fork_history(active).unwrap().collect::<Vec<_>>(),
            restored.fork_history(active).unwrap().collect::<Vec<_>>()
        );
        assert_eq!(
            restored.fork_info(discarded).unwrap().status,
            chronograph_db::ForkStatus::Discarded
        );
        assert_eq!(
            restored.fork_info(merged).unwrap().status,
            chronograph_db::ForkStatus::Merged
        );
        assert!(restored.contains_node(NodeId(u64::MAX)));
        assert!(restore(&source, &dest).is_err());
        assert_eq!(fs::read(source).unwrap(), original);
    }
    #[test]
    fn invalid_and_incomplete_archives_leave_no_destination() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("bad.tar");
        let dest = d.path().join("restore");
        for body in [b"".as_slice(), b"bad archive"] {
            fs::write(&source, body).unwrap();
            assert!(restore(&source, &dest).is_err());
            assert!(!dest.exists());
            assert_eq!(fs::read(&source).unwrap(), body);
        }
        assert!(!allowed("sidecars/../../auth.json"));
        assert!(!allowed("/graph.cgraph"));
        assert!(!allowed("auth.json"));
        assert!(!allowed("sidecars\\x"));
    }
}
