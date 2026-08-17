// feature_id: v3.config_mgmt_store
// Config Core 的落盘编排：读取 authoring、编译校验、原子替换、备份与修订记录。
// 原子写复用 routecodex-v3-config 的 V3ConfigStore（tmp + rename）；
// 本模块只追加备份与 revision 管理，不重复实现配置语义。
use routecodex_v3_config::{V3Config02AuthoringParsed, V3Config05ManifestPublished, V3ConfigStore};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use crate::provider::backup_file;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConfigRevision {
    pub seq: u64,
    pub ts: String,
    pub action: String,
    pub target: String,
    pub reason: String,
    pub backup: Option<String>,
    pub source_sha256: String,
    pub result: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitOutcome {
    pub backup: Option<PathBuf>,
    pub revision: ConfigRevision,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3ConfigMgmtError {
    #[error("config core: {0}")]
    Config(String),
    #[error("revision store: {0}")]
    Revision(String),
    #[error("io: {0}")]
    Io(String),
}

impl From<routecodex_v3_config::V3ConfigError> for V3ConfigMgmtError {
    fn from(error: routecodex_v3_config::V3ConfigError) -> Self {
        V3ConfigMgmtError::Config(error.to_string())
    }
}

impl From<std::io::Error> for V3ConfigMgmtError {
    fn from(error: std::io::Error) -> Self {
        V3ConfigMgmtError::Io(error.to_string())
    }
}

impl From<String> for V3ConfigMgmtError {
    fn from(message: String) -> Self {
        V3ConfigMgmtError::Config(message)
    }
}

pub fn default_revision_store_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("state")
        .join("config-revisions.json")
}

#[derive(Debug, Clone)]
pub struct RevisionStore {
    path: PathBuf,
}

impl RevisionStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn list(&self) -> Result<Vec<ConfigRevision>, V3ConfigMgmtError> {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Vec::new());
            }
            Err(error) => return Err(V3ConfigMgmtError::Io(error.to_string())),
        };
        let decoded: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|error| V3ConfigMgmtError::Revision(error.to_string()))?;
        let revisions = decoded
            .get("revisions")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| serde_json::from_value::<ConfigRevision>(item.clone()).ok())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(revisions)
    }

    pub fn append(
        &self,
        action: &str,
        target: &str,
        reason: &str,
        backup: Option<&Path>,
        source_sha256: &str,
        result: &str,
    ) -> Result<ConfigRevision, V3ConfigMgmtError> {
        let mut revisions = self.list()?;
        let seq = revisions.last().map(|last| last.seq + 1).unwrap_or(1);
        let revision = ConfigRevision {
            seq,
            ts: crate::provider::timestamp_compact(),
            action: action.to_string(),
            target: target.to_string(),
            reason: reason.to_string(),
            backup: backup.map(|path| path.display().to_string()),
            source_sha256: source_sha256.to_string(),
            result: result.to_string(),
        };
        revisions.push(revision.clone());
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let payload = serde_json::to_string_pretty(&serde_json::json!({
            "schema_version": 1,
            "revisions": revisions,
        }))
        .map_err(|error| V3ConfigMgmtError::Revision(error.to_string()))?;
        let temp_path = self.path.with_extension(format!("json.tmp-{}", std::process::id()));
        std::fs::write(&temp_path, payload)?;
        std::fs::rename(&temp_path, &self.path)?;
        Ok(revision)
    }
}

#[derive(Debug, Clone)]
pub struct ConfigMgmtStore {
    config_path: PathBuf,
    revision_store: RevisionStore,
}

impl ConfigMgmtStore {
    pub fn new(config_path: impl Into<PathBuf>) -> Self {
        let config_path = config_path.into();
        let revision_store = RevisionStore::new(default_revision_store_path(&config_path));
        Self {
            config_path,
            revision_store,
        }
    }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    pub fn revision_store(&self) -> &RevisionStore {
        &self.revision_store
    }

    /// 读取当前 authoring（含 provider 目录解析）。
    pub fn read_authoring(&self) -> Result<V3Config02AuthoringParsed, V3ConfigMgmtError> {
        Ok(V3ConfigStore::new(&self.config_path).read_authoring()?)
    }

    /// 编译校验（authoring -> manifest），失败显式返回，不做任何落盘。
    /// 校验走与 runtime 一致的完整解析：authoring 序列化到同目录临时文件后
    /// 经 V3ConfigStore.load_snapshot 编译（含 provider 目录解析与引用校验）。
    pub fn validate(
        &self,
        authoring: &V3Config02AuthoringParsed,
    ) -> Result<V3Config05ManifestPublished, V3ConfigMgmtError> {
        let serialized = V3ConfigStore::new(&self.config_path)
            .plan_write(authoring)?
            .serialized_toml;
        let temp_path = self
            .config_path
            .with_extension(format!("toml.tmp-{}", std::process::id()));
        std::fs::write(&temp_path, serialized)?;
        let result = V3ConfigStore::new(&temp_path).load_snapshot();
        let _ = std::fs::remove_file(&temp_path);
        Ok(result?)
    }

    /// 校验通过后原子替换：备份 -> 临时文件 -> rename -> revision 记录。
    /// 任一步失败不改变原配置（备份与 revision 都发生在替换前/后显式记录）。
    pub fn commit_with_backup(
        &self,
        authoring: &V3Config02AuthoringParsed,
        action: &str,
        reason: &str,
    ) -> Result<CommitOutcome, V3ConfigMgmtError> {
        self.validate(authoring)?;
        let source_sha256 = match std::fs::read(&self.config_path) {
            Ok(raw) => format!("{:x}", Sha256::digest(raw)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                "absent".to_string()
            }
            Err(error) => return Err(V3ConfigMgmtError::Io(error.to_string())),
        };
        let backup = if self.config_path.exists() {
            Some(backup_file(&self.config_path, reason)?)
        } else {
            None
        };
        let store = V3ConfigStore::new(&self.config_path);
        let plan = store.plan_write(authoring)?;
        store.commit_write_atomic(plan)?;
        let revision = self.revision_store.append(
            action,
            "config.v3.toml",
            reason,
            backup.as_deref(),
            &source_sha256,
            "committed",
        )?;
        Ok(CommitOutcome { backup, revision })
    }
}
