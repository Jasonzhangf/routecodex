use serde::{Deserialize, Serialize};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ActiveKeyControlEndpointRecord {
    pub schema_version: u8,
    pub server_id: String,
    pub business_addr: SocketAddr,
    pub control_addr: SocketAddr,
    pub owner_pid: u32,
}

pub(crate) fn record_path(config_path: &Path, server_id: &str) -> io::Result<PathBuf> {
    let config = std::fs::canonicalize(config_path)?;
    let parent = config.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "canonical config has no parent",
        )
    })?;
    let file_name = format!(
        "active-key-control-{}-{}.json",
        percent_encode(config.file_name().unwrap().as_encoded_bytes()),
        percent_encode(server_id.as_bytes())
    );
    Ok(parent.join(file_name))
}

pub(crate) fn control_bind_address(business: SocketAddr) -> Option<SocketAddr> {
    match business {
        SocketAddr::V4(addr) if addr.ip().is_loopback() => Some(business),
        SocketAddr::V6(addr) if addr.ip().is_loopback() => Some(business),
        SocketAddr::V4(addr) if addr.ip().is_unspecified() => Some(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            addr.port(),
        )),
        SocketAddr::V6(addr) if addr.ip().is_unspecified() => Some(SocketAddr::new(
            IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
            addr.port(),
        )),
        _ => None,
    }
}

pub(crate) fn companion_bind_address() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)
}

pub(crate) fn make_record(
    server_id: &str,
    business_addr: SocketAddr,
    control_addr: SocketAddr,
) -> ActiveKeyControlEndpointRecord {
    ActiveKeyControlEndpointRecord {
        schema_version: 1,
        server_id: server_id.to_string(),
        business_addr,
        control_addr,
        owner_pid: std::process::id(),
    }
}

pub(crate) fn publish_record(
    path: &Path,
    record: &ActiveKeyControlEndpointRecord,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(record).map_err(io::Error::other)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    use std::io::Write;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        std::fs::remove_file(path).map_err(|cleanup| {
            io::Error::other(format!(
                "{error}; remove incomplete owned control record: {cleanup}"
            ))
        })?;
        return Err(error);
    }
    Ok(())
}

pub(crate) fn remove_owned_record(
    path: &Path,
    expected: &ActiveKeyControlEndpointRecord,
) -> io::Result<bool> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let current: ActiveKeyControlEndpointRecord =
        serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if &current != expected {
        return Ok(false);
    }
    std::fs::remove_file(path)?;
    Ok(true)
}

fn percent_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(bytes.len());
    for byte in bytes {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.') {
            encoded.push(*byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_mapping_preserves_loopback_and_matches_wildcard_family() {
        let specific: SocketAddr = "127.0.0.2:3210".parse().unwrap();
        assert_eq!(control_bind_address(specific), Some(specific));
        let ipv4: SocketAddr = "0.0.0.0:3210".parse().unwrap();
        assert_eq!(
            control_bind_address(ipv4),
            Some("127.0.0.1:3210".parse().unwrap())
        );
        let ipv6: SocketAddr = "[::]:3210".parse().unwrap();
        assert_eq!(
            control_bind_address(ipv6),
            Some("[::1]:3210".parse().unwrap())
        );
        let external: SocketAddr = "192.0.2.4:3210".parse().unwrap();
        assert_eq!(control_bind_address(external), None);
    }

    #[test]
    fn record_cleanup_removes_only_the_published_owner_endpoint() {
        let dir =
            std::env::temp_dir().join(format!("active-key-control-record-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("record.json");
        let record = make_record(
            "listener",
            "127.0.0.1:3210".parse().unwrap(),
            "127.0.0.1:0".parse().unwrap(),
        );
        publish_record(&path, &record).unwrap();
        let other = make_record(
            "listener",
            record.business_addr,
            "127.0.0.1:3211".parse().unwrap(),
        );
        assert!(!remove_owned_record(&path, &other).unwrap());
        assert!(path.exists());
        assert!(remove_owned_record(&path, &record).unwrap());
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
