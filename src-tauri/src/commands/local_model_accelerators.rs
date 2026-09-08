//! Early physical GPU inventory, independent of a verified inference backend.
//! DXGI memory limits never become global free VRAM or additional system RAM.
use super::AcceleratorSnapshot;

/// Keep the existing NVML CUDA devices and supplement missing vendors on Windows.
/// DXGI adapter ordinals/LUIDs are never equated with CUDA or Vulkan ordinals.
pub(super) fn supplemental_snapshot(nvml_present: bool) -> Vec<AcceleratorSnapshot> {
    #[cfg(windows)]
    {
        let inventory = native::inspect();
        supplemental_entries(inventory.entries, nvml_present)
    }
    #[cfg(not(windows))]
    {
        let _ = nvml_present;
        Vec::new()
    }
}

#[cfg(any(windows, test))]
const MAX_ADAPTERS: u32 = 32;
#[cfg(any(windows, test))]
const NVIDIA_VENDOR: u32 = 0x10de;
#[cfg(any(windows, test))]
const EXCLUDED_ADAPTER_FLAGS: u32 = 0x1 | 0x2; // DXGI REMOTE | SOFTWARE

#[cfg(any(windows, test))]
#[derive(Debug)]
struct AdapterEvidence {
    description: Vec<u16>,
    vendor_id: u32,
    luid_high: i32,
    luid_low: u32,
    flags: u32,
    dedicated_video_bytes: u64,
    dedicated_system_bytes: u64,
    shared_system_limit_bytes: u64,
}

#[cfg(any(windows, test))]
#[derive(Debug)]
struct InventoryEntry {
    vendor_id: u32,
    snapshot: AcceleratorSnapshot,
}

#[cfg(any(windows, test))]
#[derive(Debug)]
struct Inventory {
    entries: Vec<InventoryEntry>,
    reason_code: Option<&'static str>,
}

#[cfg(any(windows, test))]
impl Inventory {
    fn unavailable(reason_code: &'static str) -> Self {
        Self {
            entries: Vec::new(),
            reason_code: Some(reason_code),
        }
    }
}

#[cfg(any(windows, test))]
fn map_adapter(evidence: AdapterEvidence) -> Option<InventoryEntry> {
    if evidence.flags & EXCLUDED_ADAPTER_FLAGS != 0 {
        return None;
    }
    let end = evidence
        .description
        .iter()
        .take(128)
        .position(|unit| *unit == 0)
        .unwrap_or(evidence.description.len().min(128));
    let description = String::from_utf16_lossy(&evidence.description[..end]);
    let name: String = description.chars().filter(|ch| !ch.is_control()).collect();
    let name = name.trim();
    Some(InventoryEntry {
        vendor_id: evidence.vendor_id,
        snapshot: AcceleratorSnapshot {
            // Locally unique for this Windows boot; not a persisted device ID.
            id: format!(
                "dxgi-{:08x}-{:08x}",
                evidence.luid_high as u32, evidence.luid_low
            ),
            backend: "unknown".into(),
            name: if name.is_empty() { "Windows GPU" } else { name }.into(),
            total_bytes: Some(evidence.dedicated_video_bytes),
            // QueryVideoMemoryInfo is the calling process's budget/usage, not
            // global free VRAM or the llama-server child's memory allowance.
            available_bytes: None,
            detection_source: "dxgi".into(),
            dedicated_system_bytes: Some(evidence.dedicated_system_bytes),
            shared_system_limit_bytes: Some(evidence.shared_system_limit_bytes),
        },
    })
}

#[cfg(any(windows, test))]
fn supplemental_entries(
    entries: Vec<InventoryEntry>,
    nvml_present: bool,
) -> Vec<AcceleratorSnapshot> {
    let mut seen_luids = std::collections::HashSet::new();
    entries
        .into_iter()
        .take(MAX_ADAPTERS as usize)
        // NVML does not expose a LUID through the current Rust wrapper. Keep
        // its NVIDIA coverage rather than guessing physical identity by name
        // or index. If NVML covers only part of a multi-NVIDIA system, this
        // conservative first-pass inventory may under-report those devices.
        .filter(|entry| !(nvml_present && entry.vendor_id == NVIDIA_VENDOR))
        .filter(|entry| seen_luids.insert(entry.snapshot.id.clone()))
        .map(|entry| entry.snapshot)
        .collect()
}

#[cfg(any(windows, test))]
mod bounded {
    use super::Inventory;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    struct Permit(Arc<AtomicBool>);

    impl Drop for Permit {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }

    pub(super) fn run(
        active: Arc<AtomicBool>,
        deadline: Duration,
        probe: impl FnOnce(&AtomicBool) -> Inventory + Send + 'static,
    ) -> Inventory {
        if active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Inventory::unavailable("accelerator_inventory_busy");
        }
        let permit = Permit(active);
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("luczor-gpu-inventory".into())
            .spawn(move || {
                let result = probe(&worker_cancel);
                // Releasing before delivery avoids a false busy result on
                // the next sequential probe. COM objects are already dropped.
                drop(permit);
                let _ = sender.send(result);
            });
        if worker.is_err() {
            return Inventory::unavailable("accelerator_inventory_worker_unavailable");
        }
        match receiver.recv_timeout(deadline) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                cancel.store(true, Ordering::Release);
                // COM driver calls have no safe forced thread cancellation.
                // Keep one permit until this worker really returns. Future
                // calls fail busy instead of accumulating stalled threads.
                Inventory::unavailable("accelerator_inventory_timeout")
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Inventory::unavailable("accelerator_inventory_worker_failed")
            }
        }
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, OnceLock};
    use std::time::Duration;
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ERROR_NOT_FOUND};

    const DEADLINE: Duration = Duration::from_secs(2);
    static ACTIVE: OnceLock<Arc<AtomicBool>> = OnceLock::new();

    pub(super) fn inspect() -> Inventory {
        bounded::run(
            ACTIVE
                .get_or_init(|| Arc::new(AtomicBool::new(false)))
                .clone(),
            DEADLINE,
            collect,
        )
    }

    fn collect(cancel: &AtomicBool) -> Inventory {
        if cancel.load(Ordering::Acquire) {
            return Inventory::unavailable("accelerator_inventory_timeout");
        }
        // All COM interfaces are created, queried and released on this worker.
        // This does not instantiate a graphics device or load an AI model.
        let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
            Ok(factory) => factory,
            Err(_) => return Inventory::unavailable("accelerator_inventory_unavailable"),
        };
        let mut result = Inventory {
            entries: Vec::new(),
            reason_code: None,
        };
        for index in 0..MAX_ADAPTERS {
            if cancel.load(Ordering::Acquire) {
                result.reason_code = Some("accelerator_inventory_timeout");
                return result;
            }
            let adapter = match unsafe { factory.EnumAdapters1(index) } {
                Ok(adapter) => adapter,
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => return result,
                Err(_) => {
                    result.reason_code = Some("accelerator_inventory_partial");
                    return result;
                }
            };
            if cancel.load(Ordering::Acquire) {
                result.reason_code = Some("accelerator_inventory_timeout");
                return result;
            }
            let Ok(description) = (unsafe { adapter.GetDesc1() }) else {
                result.reason_code = Some("accelerator_inventory_partial");
                continue;
            };
            if let Some(entry) = map_adapter(AdapterEvidence {
                description: description.Description.to_vec(),
                vendor_id: description.VendorId,
                luid_high: description.AdapterLuid.HighPart,
                luid_low: description.AdapterLuid.LowPart,
                flags: description.Flags,
                dedicated_video_bytes: description.DedicatedVideoMemory as u64,
                dedicated_system_bytes: description.DedicatedSystemMemory as u64,
                shared_system_limit_bytes: description.SharedSystemMemory as u64,
            }) {
                result.entries.push(entry);
            }
        }
        result.reason_code = Some("accelerator_inventory_truncated");
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    fn evidence(vendor_id: u32, luid_low: u32) -> AdapterEvidence {
        AdapterEvidence {
            description: "Example GPU\0ignored".encode_utf16().collect(),
            vendor_id,
            luid_high: -1,
            luid_low,
            flags: 0,
            dedicated_video_bytes: 8 * 1024 * 1024 * 1024,
            dedicated_system_bytes: 128 * 1024 * 1024,
            shared_system_limit_bytes: 16 * 1024 * 1024 * 1024,
        }
    }

    #[test]
    fn dxgi_memory_sources_are_separate_and_never_claim_vulkan_or_free_memory() {
        for vendor in [0x1002, 0x8086, NVIDIA_VENDOR, 0xffff] {
            let entry = map_adapter(evidence(vendor, 42)).unwrap().snapshot;
            assert_eq!(entry.id, "dxgi-ffffffff-0000002a");
            assert_eq!(entry.backend, "unknown");
            assert_eq!(entry.detection_source, "dxgi");
            assert_eq!(entry.name, "Example GPU");
            assert_eq!(entry.total_bytes, Some(8 * 1024 * 1024 * 1024));
            assert_eq!(entry.available_bytes, None);
            assert_eq!(entry.dedicated_system_bytes, Some(128 * 1024 * 1024));
            assert_eq!(
                entry.shared_system_limit_bytes,
                Some(16 * 1024 * 1024 * 1024)
            );
        }
    }

    #[test]
    fn shared_memory_never_counts_as_dedicated_vram_even_with_zero_dedicated() {
        let mut shared = evidence(0x8086, 1);
        shared.dedicated_video_bytes = 0;
        let entry = map_adapter(shared).unwrap().snapshot;
        assert_eq!(entry.total_bytes, Some(0));
        assert_eq!(entry.available_bytes, None);
        assert!(entry.shared_system_limit_bytes.unwrap() > 0);
    }

    #[test]
    fn remote_and_software_adapters_are_not_physical_inference_candidates() {
        for flags in [1, 2, 3] {
            let mut adapter = evidence(0x1414, 1);
            adapter.flags = flags;
            assert!(map_adapter(adapter).is_none());
        }
    }

    #[test]
    fn nvml_nvidia_is_preserved_without_guessing_adapter_index_or_name_matches() {
        let entries = || {
            vec![
                map_adapter(evidence(NVIDIA_VENDOR, 1)).unwrap(),
                map_adapter(evidence(0x1002, 4)).unwrap(),
                map_adapter(evidence(0x8086, 9)).unwrap(),
                map_adapter(evidence(0x1002, 4)).unwrap(),
            ]
        };
        let with_nvml = supplemental_entries(entries(), true);
        assert_eq!(with_nvml.len(), 2);
        assert_eq!(with_nvml[0].id, "dxgi-ffffffff-00000004");
        assert!(with_nvml.iter().all(|entry| entry.backend == "unknown"));
        let without_nvml = supplemental_entries(entries(), false);
        // Identical LUID is a duplicate DXGI device, not a name/index match.
        assert_eq!(without_nvml.len(), 3);
        assert_eq!(without_nvml[0].backend, "unknown");
    }

    #[test]
    fn adapter_names_are_bounded_and_safe_for_display() {
        let mut adapter = evidence(0x1002, 1);
        adapter.description = "\n  \0ignored".encode_utf16().collect();
        assert_eq!(map_adapter(adapter).unwrap().snapshot.name, "Windows GPU");
        let mut adapter = evidence(0x1002, 1);
        adapter.description = vec![b'x' as u16; 300];
        assert_eq!(map_adapter(adapter).unwrap().snapshot.name.len(), 128);
    }

    #[test]
    fn serialization_keeps_unknown_free_memory_and_shared_limit_explicit() {
        let entry = map_adapter(evidence(0x1002, 1)).unwrap().snapshot;
        let json = serde_json::to_value(entry).unwrap();
        assert_eq!(json["detectionSource"], "dxgi");
        assert_eq!(json["backend"], "unknown");
        assert!(json["availableBytes"].is_null());
        assert!(json["dedicatedSystemBytes"].is_u64());
        assert!(json["sharedSystemLimitBytes"].is_u64());
        assert_eq!(json.as_object().unwrap().len(), 8);
    }

    #[test]
    fn timeout_keeps_single_worker_permit_until_driver_probe_really_finishes() {
        let active = Arc::new(AtomicBool::new(false));
        let (release, blocking) = mpsc::channel();
        let (finished, completion) = mpsc::channel();
        let result = bounded::run(active.clone(), Duration::from_millis(20), move |cancel| {
            let _ = blocking.recv();
            assert!(cancel.load(Ordering::Acquire));
            let _ = finished.send(());
            Inventory::unavailable("test_completed")
        });
        assert_eq!(result.reason_code, Some("accelerator_inventory_timeout"));
        assert!(active.load(Ordering::Acquire));
        let result = bounded::run(active.clone(), Duration::from_secs(1), |_| {
            panic!("A timed-out worker must not permit a second driver probe")
        });
        assert_eq!(result.reason_code, Some("accelerator_inventory_busy"));
        release.send(()).unwrap();
        completion.recv_timeout(Duration::from_secs(1)).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(1);
        while active.load(Ordering::Acquire) && std::time::Instant::now() < until {
            std::thread::yield_now();
        }
        assert!(!active.load(Ordering::Acquire));
    }

    #[test]
    fn completed_probe_can_be_run_again_and_adapter_output_is_bounded() {
        let active = Arc::new(AtomicBool::new(false));
        for _ in 0..2 {
            let result = bounded::run(active.clone(), Duration::from_secs(1), |_| Inventory {
                entries: Vec::new(),
                reason_code: None,
            });
            assert!(result.reason_code.is_none());
            assert!(!active.load(Ordering::Acquire));
        }
        let entries = (0..MAX_ADAPTERS + 10)
            .map(|index| map_adapter(evidence(0x1002, index)).unwrap())
            .collect();
        assert_eq!(
            supplemental_entries(entries, false).len(),
            MAX_ADAPTERS as usize
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Explicit opt-in: read-only native DXGI inventory, no model or graphics device start"]
    fn dxgi_inventory_live_readonly() {
        let inventory = native::inspect();
        println!("DXGI inventory reason: {:?}", inventory.reason_code);
        assert!(inventory.reason_code.is_none());
        let entries = supplemental_entries(inventory.entries, false);
        assert!(
            !entries.is_empty(),
            "Opt-in acceptance expects a hardware adapter"
        );
        assert!(entries.iter().all(|entry| {
            entry.backend == "unknown"
                && entry.available_bytes.is_none()
                && entry.detection_source == "dxgi"
        }));
        println!("{}", serde_json::to_string(&entries).unwrap());
    }
}
