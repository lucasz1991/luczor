//! Bounded local diagnostics, with no configurable commands or filesystem paths.
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{Disks, ProcessRefreshKind, ProcessesToUpdate, System, MINIMUM_CPU_UPDATE_INTERVAL};

use super::execution::ExecutionLease;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticsPayload {
    #[serde(default = "default_true")]
    pub include_processes: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SourceStatus {
    Ready,
    Unavailable,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source<T> {
    status: SourceStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    data: Option<T>,
}

impl<T> Source<T> {
    fn unavailable(reason: &str) -> Self {
        Self {
            status: SourceStatus::Unavailable,
            reason: Some(reason.into()),
            data: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DefenderStatus {
    antivirus_enabled: Option<bool>,
    realtime_protection_enabled: Option<bool>,
    antispyware_enabled: Option<bool>,
    tamper_protected: Option<bool>,
    signature_age_days: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FirewallProfile {
    profile: String,
    enabled: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateStatus {
    latest_hotfix_id: String,
    installed_at: String,
    pending_updates_checked: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SecurityReport {
    defender: Source<DefenderStatus>,
    firewall: Source<Vec<FirewallProfile>>,
    updates: Source<UpdateStatus>,
}

impl SecurityReport {
    fn unavailable(reason: &str) -> Self {
        Self {
            defender: Source::unavailable(reason),
            firewall: Source::unavailable(reason),
            updates: Source::unavailable(reason),
        }
    }
}

#[derive(Debug, Serialize, Clone)]
struct ProcessMetrics {
    name: String,
    ram_mb: u64,
    cpu_percent_of_device: f32,
}

#[derive(Debug, Serialize)]
struct DiskMetrics {
    index: usize,
    kind: String,
    removable: bool,
    total_mb: u64,
    available_mb: u64,
}

#[derive(Debug, Serialize)]
pub struct DiagnosticsReport {
    version: u8,
    captured_at_unix_ms: u128,
    status: &'static str,
    os: Option<String>,
    os_version: Option<String>,
    cpu_name: Option<String>,
    logical_cpu_count: usize,
    cpu_percent: f32,
    sample_ms: u128,
    ram_total_mb: u64,
    ram_available_mb: u64,
    swap_total_mb: u64,
    swap_used_mb: u64,
    disks: Vec<DiskMetrics>,
    processes_included: bool,
    top_memory_processes: Vec<ProcessMetrics>,
    top_cpu_processes: Vec<ProcessMetrics>,
    security: SecurityReport,
    limitations: Vec<&'static str>,
}

static ACTIVE: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn collect(
    payload: DiagnosticsPayload,
    lease: ExecutionLease,
) -> Result<DiagnosticsReport, String> {
    let _guard = ACTIVE
        .get_or_init(|| Mutex::new(()))
        .try_lock()
        .map_err(|_| "A system diagnostic is already running.")?;
    lease.check()?;
    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_all();
    let refresh = ProcessRefreshKind::new().with_memory().with_cpu();
    if payload.include_processes {
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh);
    }
    std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
    lease.check()?;
    system.refresh_cpu_usage();
    if payload.include_processes {
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh);
    }
    let cores = system.cpus().len().max(1) as f32;
    let processes: Vec<_> = system
        .processes()
        .values()
        .map(|process| ProcessMetrics {
            name: process
                .name()
                .to_string_lossy()
                .chars()
                .filter(|ch| !ch.is_control())
                .take(128)
                .collect(),
            ram_mb: process.memory() / 1024 / 1024,
            cpu_percent_of_device: percent(process.cpu_usage() / cores),
        })
        .collect();
    let (top_memory_processes, top_cpu_processes) = rank_processes(processes);
    let disks = Disks::new_with_refreshed_list()
        .iter()
        .take(32)
        .enumerate()
        .map(|(index, disk)| DiskMetrics {
            index: index + 1,
            kind: format!("{:?}", disk.kind()),
            removable: disk.is_removable(),
            total_mb: disk.total_space() / 1024 / 1024,
            available_mb: disk.available_space() / 1024 / 1024,
        })
        .collect();
    let security = collect_security(&lease);
    lease.check()?;
    let security_ready = matches!(security.defender.status, SourceStatus::Ready)
        && matches!(security.firewall.status, SourceStatus::Ready)
        && matches!(security.updates.status, SourceStatus::Ready);
    Ok(DiagnosticsReport {
        version: 1,
        captured_at_unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        status: if security_ready { "ready" } else { "partial" },
        os: System::name(),
        os_version: System::long_os_version(),
        cpu_name: system.cpus().first().map(|cpu| cpu.brand().chars().take(128).collect()),
        logical_cpu_count: system.cpus().len(),
        cpu_percent: percent(system.global_cpu_usage()),
        sample_ms: MINIMUM_CPU_UPDATE_INTERVAL.as_millis(),
        ram_total_mb: system.total_memory() / 1024 / 1024,
        ram_available_mb: system.available_memory() / 1024 / 1024,
        swap_total_mb: system.total_swap() / 1024 / 1024,
        swap_used_mb: system.used_swap() / 1024 / 1024,
        disks,
        processes_included: payload.include_processes,
        top_memory_processes,
        top_cpu_processes,
        security,
        limitations: vec![
            "Short local sample, not a performance trend or security audit. Process memory may include shared pages.",
            "Unavailable security sources are unknown, not disabled or safe. Other antivirus products are not assessed.",
            "Firewall values describe configured profiles, not internet reachability. Installed hotfix metadata does not prove updates are current.",
            "No file contents, command lines, environment variables, user accounts, browser data, disk health tests or changes are collected.",
        ],
    })
}

fn percent(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

fn rank_processes(
    mut processes: Vec<ProcessMetrics>,
) -> (Vec<ProcessMetrics>, Vec<ProcessMetrics>) {
    processes.sort_by(|left, right| right.ram_mb.cmp(&left.ram_mb));
    let memory = processes.iter().take(8).cloned().collect();
    processes.sort_by(|left, right| {
        right
            .cpu_percent_of_device
            .total_cmp(&left.cpu_percent_of_device)
    });
    processes.truncate(8);
    (memory, processes)
}

#[cfg(windows)]
fn collect_security(lease: &ExecutionLease) -> SecurityReport {
    use std::process::Command;
    let Some(system_root) = std::env::var_os("SystemRoot") else {
        return SecurityReport::unavailable("system_runtime_unavailable");
    };
    let executable = std::path::PathBuf::from(system_root)
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    if !executable.is_absolute() || !executable.is_file() {
        return SecurityReport::unavailable("system_runtime_unavailable");
    }
    let mut command = Command::new(executable);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        include_str!("system_diagnostics.ps1"),
    ]);
    let result = super::process::run_bounded_command_guarded(
        command,
        None,
        Duration::from_secs(20),
        64 * 1024,
        Some(lease.clone()),
    );
    match result {
        Ok(output) if output.success && !output.stdout_truncated => {
            serde_json::from_str(output.stdout.trim_start_matches('\u{feff}').trim())
                .unwrap_or_else(|_| SecurityReport::unavailable("invalid_collector_output"))
        }
        Ok(output) if output.timed_out => SecurityReport::unavailable("collector_timeout"),
        _ => SecurityReport::unavailable("collector_unavailable"),
    }
}

#[cfg(not(windows))]
fn collect_security(_lease: &ExecutionLease) -> SecurityReport {
    SecurityReport::unavailable("unsupported_platform")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_commands_paths_and_unknown_diagnostic_options() {
        assert!(serde_json::from_str::<DiagnosticsPayload>(r#"{"command":"whoami"}"#).is_err());
        assert!(
            serde_json::from_str::<DiagnosticsPayload>(r#"{"includeProcesses":"true"}"#).is_err()
        );
        assert!(
            !serde_json::from_str::<DiagnosticsPayload>(r#"{"includeProcesses":false}"#)
                .unwrap()
                .include_processes
        );
    }

    #[test]
    fn bounded_rankings_preserve_distinct_cpu_and_memory_bottlenecks() {
        let rows = (0..20)
            .map(|index| ProcessMetrics {
                name: format!("process-{index}"),
                ram_mb: index,
                cpu_percent_of_device: (20 - index) as f32,
            })
            .collect();
        let (memory, cpu) = rank_processes(rows);
        assert_eq!(memory.len(), 8);
        assert_eq!(cpu.len(), 8);
        assert_eq!(memory[0].name, "process-19");
        assert_eq!(cpu[0].name, "process-0");
    }

    #[test]
    fn unavailable_security_never_implies_protection_is_disabled() {
        let report = serde_json::to_value(SecurityReport::unavailable("not_authorized")).unwrap();
        assert_eq!(report["defender"]["status"], "unavailable");
        assert!(report["defender"]["data"].is_null());
        assert!(!report.to_string().contains("false"));
    }
}
