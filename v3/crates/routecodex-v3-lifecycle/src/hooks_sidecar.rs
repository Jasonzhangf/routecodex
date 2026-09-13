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
    instance_dir: &Path,
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
    let mut sidecar_command = TokioCommand::new(&wrapper);
    sidecar_command
        .arg("--config")
        .arg(&daemon_config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // d7cb31f：sidecar stderr 落到实例目录诊断文件，退出原因可追溯
        //（此前 Stdio::null 吞掉了 codexapp AddrInUse 等全部失败原因）。
        .stderr(stderr_capture(&instance_dir)?)
        // d7cb31f：supervisor 需要 internal codexapp 可执行文件路径；
        // lifecycle 从 install record 的 bin_directory 解析并注入，
        // 不再依赖外部 shell 预先导出 ROUTECODEX_V3_CODEXAPP_BINARY。
        .env(
            "ROUTECODEX_V3_CODEXAPP_BINARY",
            codexapp_binary_from_record(&record, &record_path)?,
        )
        // 独立进程组：失败终止时可整组杀掉，杜绝孤儿 codexapp 占用 socket。
        .process_group(0);
    let mut child = sidecar_command.spawn().map_err(|error| {
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
            cleanup_codexapp_socket(&daemon_config);
            return Err(error);
        }
        Err(_) => {
            let _ = terminate_sidecar(&mut child).await;
            cleanup_codexapp_socket(&daemon_config);
            return Err(V3LifecycleError::Timeout(
                "hooks sidecar readiness".to_string(),
            ));
        }
    };
    if readiness.get("protocol").and_then(Value::as_str) != Some("routecodex-hooks-supervisor/v1")
        || readiness.get("ready").and_then(Value::as_bool) != Some(true)
    {
        terminate_sidecar(&mut child).await?;
        cleanup_codexapp_socket(&daemon_config);
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
    match start_configured_hooks_sidecar(instance_dir).await {
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
    // d7cb31f：按进程组终止，级联杀掉 supervisor 的 codexapp/hooksd 子进程，
    // 防止孤儿进程在失败重启后继续占用 codexapp socket。
    let result = unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGTERM) };
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

// d7cb31f：sidecar 失败时清理 codexapp unix socket——残留 socket 会让
// 后续所有 restart 因 AddrInUse 失败（孤儿进程终止后 socket 文件仍在）。
fn cleanup_codexapp_socket(daemon_config: &Path) {
    let Ok(Some(socket)) =
        routecodex_v3_config::read_codexapp_socket_from_daemon_config(daemon_config)
    else {
        return;
    };
    let _ = fs::remove_file(socket);
}

// d7cb31f：internal codexapp 可执行文件路径由 lifecycle 从 install record
// 解析并注入 supervisor，不再依赖外部 shell 导出 ROUTECODEX_V3_CODEXAPP_BINARY。
fn codexapp_binary_from_record(
    record: &Value,
    record_path: &Path,
) -> Result<std::path::PathBuf, V3LifecycleError> {
    let bin_directory = record
        .get("bin_directory")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            V3LifecycleError::Validation(format!(
                "hooks install record {} has no bin_directory",
                record_path.display()
            ))
        })?;
    let candidate = std::path::Path::new(bin_directory).join("rccv3-codexapp");
    if !candidate.is_file() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {} requires installed internal codexapp binary at {}",
            record_path.display(),
            candidate.display()
        )));
    }
    Ok(candidate)
}

// d7cb31f：sidecar stderr 落到实例目录诊断文件，退出原因可追溯。
fn stderr_capture(instance_dir: &Path) -> Result<Stdio, V3LifecycleError> {
    let path = instance_dir.join("hooks-sidecar.stderr.log");
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| {
            V3LifecycleError::Validation(format!(
                "hooks sidecar stderr capture {} unavailable: {error}",
                path.display()
            ))
        })?;
    Ok(Stdio::from(file))
}
