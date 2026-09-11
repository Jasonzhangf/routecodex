use super::*;
use serde_json::Value;
use std::process::Stdio;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::process::{Child, Command as TokioCommand};

const HOOKS_INSTALL_RECORD_ENV: &str = "ROUTECODEX_HOOKS_INSTALL_RECORD";
const HOOKS_INSTALL_RECORD_RELATIVE: &str = ".codex/routecodex-hooks/install.json";
const SIDECAR_START_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) struct V3HooksSidecarProcess {
    child: Child,
}

pub(crate) async fn start_configured_hooks_sidecar(
) -> Result<Option<V3HooksSidecarProcess>, V3LifecycleError> {
    let Some(record_path) = hooks_install_record_path()? else {
        return Ok(None);
    };
    let record_bytes = fs::read(&record_path)?;
    let record: Value = serde_json::from_slice(&record_bytes)?;
    if record.get("supervisor_enabled").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    let wrapper = required_record_path(&record, "supervisor_wrapper", &record_path)?;
    let daemon_config = required_record_path(&record, "daemon_config", &record_path)?;
    let mut child = TokioCommand::new(&wrapper)
        .arg("--config")
        .arg(&daemon_config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            V3LifecycleError::Validation(format!(
                "hooks sidecar failed to spawn {}: {error}",
                wrapper.display()
            ))
        })?;
    let Some(stdout) = child.stdout.take() else {
        let _ = terminate_sidecar(&mut child).await;
        return Err(V3LifecycleError::Validation(
            "hooks sidecar did not expose readiness stdout".to_string(),
        ));
    };
    let mut reader = tokio::io::BufReader::new(stdout);
    let readiness = match tokio::time::timeout(
        SIDECAR_START_TIMEOUT,
        read_sidecar_readiness(&mut reader),
    )
    .await
    {
        Ok(Ok(readiness)) => readiness,
        Ok(Err(error)) => {
            let _ = terminate_sidecar(&mut child).await;
            return Err(error);
        }
        Err(_) => {
            let _ = terminate_sidecar(&mut child).await;
            return Err(V3LifecycleError::Timeout(
                "hooks sidecar readiness".to_string(),
            ));
        }
    };
    if readiness.get("protocol").and_then(Value::as_str) != Some("routecodex-hooks-supervisor/v1")
        || readiness.get("ready").and_then(Value::as_bool) != Some(true)
    {
        terminate_sidecar(&mut child).await?;
        return Err(V3LifecycleError::Validation(
            "hooks sidecar returned an invalid readiness record".to_string(),
        ));
    }
    tokio::spawn(async move {
        let mut lines = reader.lines();
        while lines.next_line().await.ok().flatten().is_some() {}
    });
    Ok(Some(V3HooksSidecarProcess { child }))
}

pub(crate) async fn start_managed_hooks_sidecar(
    instance_dir: &Path,
    instance_id: &str,
    socket_path: &Path,
) -> Result<Option<V3HooksSidecarProcess>, V3LifecycleError> {
    match start_configured_hooks_sidecar().await {
        Ok(sidecar) => Ok(sidecar),
        Err(error) => {
            write_status(
                instance_dir,
                instance_id,
                V3ManagedRunState::Failed,
                Some(error.to_string()),
            )?;
            let _ = fs::remove_file(instance_dir.join("pid.cache"));
            let _ = fs::remove_file(instance_dir.join("control.json"));
            let _ = fs::remove_file(socket_path);
            Err(error)
        }
    }
}

impl V3HooksSidecarProcess {
    pub(crate) async fn stop(mut self) -> Result<(), V3LifecycleError> {
        terminate_sidecar(&mut self.child).await
    }
}

async fn read_sidecar_readiness(
    stdout: &mut (impl AsyncBufRead + Unpin),
) -> Result<Value, V3LifecycleError> {
    let mut line = String::new();
    let read = stdout.read_line(&mut line).await?;
    if read == 0 {
        return Err(V3LifecycleError::Validation(
            "hooks sidecar exited before readiness".to_string(),
        ));
    }
    let line = line.trim_end_matches(['\r', '\n']);
    if line.is_empty() {
        return Err(V3LifecycleError::Validation(
            "hooks sidecar emitted an empty readiness record".to_string(),
        ));
    }
    Ok(serde_json::from_str(line)?)
}

async fn terminate_sidecar(child: &mut Child) -> Result<(), V3LifecycleError> {
    let Some(pid) = child.id() else {
        return Ok(());
    };
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if result != 0 && child.try_wait()?.is_none() {
        return Err(V3LifecycleError::Io(std::io::Error::last_os_error()));
    }
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(status) => {
            status?;
            Ok(())
        }
        Err(_) => {
            child.kill().await?;
            let _ = child.wait().await?;
            Err(V3LifecycleError::Timeout(format!(
                "hooks sidecar graceful stop pid {pid}"
            )))
        }
    }
}

fn hooks_install_record_path() -> Result<Option<PathBuf>, V3LifecycleError> {
    let path = match std::env::var_os(HOOKS_INSTALL_RECORD_ENV) {
        Some(path) => PathBuf::from(path),
        None => {
            let Some(home) = std::env::var_os("HOME") else {
                return Ok(None);
            };
            PathBuf::from(home).join(HOOKS_INSTALL_RECORD_RELATIVE)
        }
    };
    if path.exists() {
        Ok(Some(fs::canonicalize(path)?))
    } else {
        Ok(None)
    }
}

fn required_record_path(
    record: &Value,
    field: &str,
    record_path: &Path,
) -> Result<PathBuf, V3LifecycleError> {
    let value = record.get(field).and_then(Value::as_str).ok_or_else(|| {
        V3LifecycleError::Validation(format!(
            "hooks install record {} is missing {field}",
            record_path.display()
        ))
    })?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {field} must be absolute"
        )));
    }
    if !path.exists() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {field} does not exist: {}",
            path.display()
        )));
    }
    Ok(path)
}
