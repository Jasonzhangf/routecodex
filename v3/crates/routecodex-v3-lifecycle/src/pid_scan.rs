use super::*;

pub(crate) fn explicit_listener_pids_for_ports(ports: &BTreeSet<u16>) -> Result<Vec<u32>, V3LifecycleError> {
    let mut pids = BTreeSet::new();
    for port in ports {
        for pid in listening_pids_for_port(*port)? {
            if pid != std::process::id() {
                pids.insert(pid);
            }
        }
    }
    Ok(pids.into_iter().collect())
}

pub(crate) fn listening_pids_for_port(port: u16) -> Result<Vec<u32>, V3LifecycleError> {
    let output = Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
        .map_err(|error| {
            V3LifecycleError::Validation(format!(
                "failed to discover explicit listener PID for port {port}: {error}"
            ))
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() && stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    if !output.status.success() {
        return Err(V3LifecycleError::Validation(format!(
            "failed to discover explicit listener PID for port {port}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let mut pids = Vec::new();
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let pid = line.parse::<u32>().map_err(|error| {
            V3LifecycleError::Validation(format!(
                "lsof returned non-numeric listener PID for port {port}: {line}: {error}"
            ))
        })?;
        if pid > 0 {
            pids.push(pid);
        }
    }
    Ok(pids)
}

pub(crate) fn guard_explicit_listener_pids_are_scoped_to_target_ports(
    pids: &[u32],
    target_ports: &BTreeSet<u16>,
) -> Result<(), V3LifecycleError> {
    for pid in pids {
        let listening_ports = listening_ports_for_pid(*pid)?;
        let extra_ports = listening_ports
            .difference(target_ports)
            .copied()
            .collect::<BTreeSet<_>>();
        if !extra_ports.is_empty() {
            return Err(V3LifecycleError::Validation(format!(
                "refusing to signal listener PID {pid} because it also owns non-target listener ports {}; target_ports={}",
                format_u16_set(&extra_ports),
                format_u16_set(target_ports)
            )));
        }
    }
    Ok(())
}

pub(crate) fn listening_ports_for_pid(pid: u32) -> Result<BTreeSet<u16>, V3LifecycleError> {
    let pid_arg = pid.to_string();
    let output = Command::new("lsof")
        .args(["-nP", "-a", "-p", &pid_arg, "-iTCP", "-sTCP:LISTEN", "-Fn"])
        .output()
        .map_err(|error| {
            V3LifecycleError::Validation(format!(
                "failed to discover listener ports for PID {pid}: {error}"
            ))
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() && stdout.trim().is_empty() {
        return Ok(BTreeSet::new());
    }
    if !output.status.success() {
        return Err(V3LifecycleError::Validation(format!(
            "failed to discover listener ports for PID {pid}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let mut ports = BTreeSet::new();
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('n'))
    {
        let Some(port) = line
            .rsplit(':')
            .next()
            .and_then(|candidate| candidate.parse::<u16>().ok())
        else {
            continue;
        };
        ports.insert(port);
    }
    Ok(ports)
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum V3LifecycleSignal {
    Terminate,
    Kill,
}

pub(crate) fn signal_explicit_listener_pids(
    pids: &[u32],
    signal: V3LifecycleSignal,
) -> Result<(), V3LifecycleError> {
    for pid in pids {
        signal_explicit_pid(*pid, signal)?;
    }
    Ok(())
}

pub(crate) fn signal_explicit_pid(pid: u32, signal: V3LifecycleSignal) -> Result<(), V3LifecycleError> {
    if pid == 0 || pid == std::process::id() {
        return Ok(());
    }
    let raw_signal = match signal {
        V3LifecycleSignal::Terminate => libc::SIGTERM,
        V3LifecycleSignal::Kill => libc::SIGKILL,
    };
    let result = unsafe { libc::kill(pid as libc::pid_t, raw_signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(V3LifecycleError::Io(error))
}

pub(crate) fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub(crate) fn format_pid_list(pids: &[u32]) -> String {
    if pids.is_empty() {
        return "none".to_string();
    }
    pids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

pub(crate) fn format_u16_set(values: &BTreeSet<u16>) -> String {
    if values.is_empty() {
        return "none".to_string();
    }
    values
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(",")
}
