use serde::Serialize;

/// Read-only snapshot consumed by the Systemstatus views.
///
/// Keeping the transport model outside the collector and command controller
/// makes additions explicit across the Rust and TypeScript boundaries.
#[derive(Debug, Serialize, Clone)]
pub struct SystemMetrics {
    pub cpu_percent: f32,
    pub ram_percent: f32,
    pub ram_used_mb: u64,
    pub ram_total_mb: u64,
    pub gpu_percent: Option<f32>,
    pub cpu_temp_c: Option<f32>,
    pub cpu_temp_source: &'static str,
    pub gpu_temp_c: Option<f32>,
    pub app_cpu_percent: Option<f32>,
    pub app_ram_percent: Option<f32>,
    pub app_ram_used_mb: Option<u64>,
    pub app_gpu_percent: Option<f32>,
    pub model_cpu_percent: Option<f32>,
    pub model_ram_percent: Option<f32>,
    pub model_ram_used_mb: Option<u64>,
    pub model_gpu_percent: Option<f32>,
    pub model_running: Option<bool>,
    /// Volumes containing the Luczor app and configured local-model directory only.
    pub disks: Vec<super::system::system_disk::DiskSample>,
    /// Legacy primary app volume for older clients. New clients should use `disks`.
    pub disk: Option<super::system::system_disk::DiskSample>,
    pub gpu_source: &'static str,
    pub network_local: super::local_model::LocalNetworkSnapshot,
}
