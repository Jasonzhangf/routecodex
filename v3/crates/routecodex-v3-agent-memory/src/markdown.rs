use super::{
    CapturedMemoryEntry, MemoryCaptureError, PROJECT_MEMORY_END_MARKER, PROJECT_MEMORY_MARKER,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn render_l3_markdown(entry: &CapturedMemoryEntry) -> String {
    let metadata = serde_json::json!({
        "id": entry.host_id,
        "category": entry.entry.category.as_str(),
        "tags": sorted_tags(&entry.entry.tags),
        "source_refs": [entry.source_ref],
    });
    format!(
        "<!-- {PROJECT_MEMORY_MARKER} {} -->\n\n# {}\n\n{}\n<!-- {PROJECT_MEMORY_END_MARKER} -->\n",
        serde_json::to_string(&metadata).expect("memory metadata serializes"),
        entry.entry.title.trim(),
        entry.entry.content.trim_end(),
    )
}

pub fn publish_l3_entry(
    root: impl AsRef<Path>,
    entry: &CapturedMemoryEntry,
) -> Result<PathBuf, MemoryCaptureError> {
    let host_id = entry.host_id.clone();
    let dir = root.as_ref().join("memory").join("L3");
    let dest = dir.join(format!("{host_id}.md"));
    let rendered = render_l3_markdown(entry);
    if dest.exists() {
        return match read_existing_l3(&dest) {
            Ok(existing) if existing == rendered => Ok(dest),
            Ok(_) => Err(MemoryCaptureError::PublicationFailed(format!(
                "destination conflicts with existing content: {}",
                dest.display()
            ))),
            Err(error) => Err(MemoryCaptureError::PublicationFailed(error.to_string())),
        };
    }
    std::fs::create_dir_all(&dir)
        .map_err(|error| MemoryCaptureError::PublicationFailed(error.to_string()))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{}.{}.{}.tmp", host_id, std::process::id(), nonce));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&tmp)
        .map_err(|error| MemoryCaptureError::PublicationFailed(error.to_string()))?;
    file.write_all(rendered.as_bytes())
        .map_err(|error| MemoryCaptureError::PublicationFailed(error.to_string()))?;
    file.sync_all()
        .map_err(|error| MemoryCaptureError::PublicationFailed(error.to_string()))?;
    if let Err(error) = std::fs::hard_link(&tmp, &dest) {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            let _ = std::fs::remove_file(&tmp);
            return match read_existing_l3(&dest) {
                Ok(existing) if existing == rendered => Ok(dest),
                Ok(_) => Err(MemoryCaptureError::PublicationFailed(format!(
                    "destination conflicts with existing content: {}",
                    dest.display()
                ))),
                Err(read_error) => Err(MemoryCaptureError::PublicationFailed(
                    read_error.to_string(),
                )),
            };
        }
        return Err(MemoryCaptureError::PublicationFailed(error.to_string()));
    }
    let _ = std::fs::remove_file(&tmp);
    Ok(dest)
}

fn read_existing_l3(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut content = String::new();
    file.read_to_string(&mut content)?;
    Ok(content)
}

pub fn stable_host_id(host_id: &str) -> String {
    let slug = host_id
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let slug = slug
        .trim_matches(|character| matches!(character, '-' | '_' | '.'))
        .to_owned();
    let prefix = if slug.is_empty() {
        "rcc-memory-host".to_owned()
    } else {
        slug.chars().take(48).collect()
    };
    let digest = Sha256::digest(host_id.as_bytes());
    let digest = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}-{digest}")
}

fn sorted_tags(tags: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    tags.iter()
        .map(|tag| tag.trim().to_ascii_lowercase())
        .filter(|tag| !tag.is_empty())
        .filter(|tag| seen.insert(tag.clone()))
        .collect()
}
