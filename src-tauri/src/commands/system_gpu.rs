//! Read-only WDDM GPU-engine measurements. Query handles live for one sample;
//! missing counters remain unavailable rather than becoming fabricated zeroes.

use std::collections::{HashMap, HashSet};
use std::mem::size_of;
use std::ptr;
use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};

const MAX_COUNTER_BUFFER: usize = 2 * 1024 * 1024;
const MAX_COUNTER_NAME: usize = 1024;

#[derive(Debug, Default, PartialEq)]
pub(super) struct GpuEngineSample {
    pub(super) total_percent: Option<f32>,
    pub(super) app_percent: Option<f32>,
    pub(super) model_percent: Option<f32>,
}

pub(super) struct WindowsGpuSampler {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
}

impl WindowsGpuSampler {
    /// Call before the CPU sampling interval; `finish` takes the second sample.
    pub(super) fn start() -> Option<Self> {
        let mut sampler = Self {
            query: ptr::null_mut(),
            counter: ptr::null_mut(),
        };
        let path: Vec<u16> = "\\GPU Engine(*)\\Utilization Percentage\0"
            .encode_utf16()
            .collect();
        // SAFETY: out-pointers are valid, the path is NUL-terminated, and Drop
        // closes the query (and its counter) on every success/failure path.
        unsafe {
            if PdhOpenQueryW(ptr::null(), 0, &mut sampler.query) != 0
                || PdhAddEnglishCounterW(sampler.query, path.as_ptr(), 0, &mut sampler.counter) != 0
                || PdhCollectQueryData(sampler.query) != 0
            {
                return None;
            }
        }
        Some(sampler)
    }

    pub(super) fn finish(
        &self,
        app_pids: &HashSet<u32>,
        model_pids: &HashSet<u32>,
    ) -> GpuEngineSample {
        // SAFETY: this object owns the live query handle throughout collection.
        if unsafe { PdhCollectQueryData(self.query) } != 0 {
            return GpuEngineSample::default();
        }
        self.read_rows()
            .map(|rows| aggregate_engines(&rows, app_pids, model_pids))
            .unwrap_or_default()
    }

    fn read_rows(&self) -> Option<Vec<EngineRow>> {
        let mut bytes = 0_u32;
        let mut count = 0_u32;
        // SAFETY: the initial call requests the required allocation size only.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut bytes,
                &mut count,
                ptr::null_mut(),
            )
        };
        if status != PDH_MORE_DATA {
            return None;
        }

        // Processes can appear during enumeration. Bound both allocation and
        // retries; the next dashboard poll can retry a racing or huge snapshot.
        for _ in 0..3 {
            let capacity = bytes as usize;
            if capacity == 0 || capacity > MAX_COUNTER_BUFFER {
                return None;
            }
            // u64 storage supplies the native structure's required alignment.
            let mut buffer = vec![0_u64; capacity.div_ceil(size_of::<u64>())];
            let status = unsafe {
                PdhGetFormattedCounterArrayW(
                    self.counter,
                    PDH_FMT_DOUBLE,
                    &mut bytes,
                    &mut count,
                    buffer.as_mut_ptr().cast(),
                )
            };
            if status == PDH_MORE_DATA {
                continue;
            }
            if status != 0
                || bytes as usize > capacity
                || count as usize > capacity / size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>()
            {
                return None;
            }
            // SAFETY: PDH successfully wrote count aligned items into this
            // allocation; all string pointers are checked against it below.
            let items = unsafe {
                std::slice::from_raw_parts(
                    buffer.as_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
                    count as usize,
                )
            };
            let mut rows = Vec::with_capacity(items.len());
            for item in items {
                let name = read_name(item.szName, &buffer, capacity)?;
                let Some((pid, engine)) = parse_engine_instance(&name) else {
                    continue;
                };
                // A new/disappearing instance can lack its first sample. Keep
                // that gap so a partially measured scope is not understated.
                let utilization = if matches!(
                    item.FmtValue.CStatus,
                    PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA
                ) {
                    // SAFETY: PDH_FMT_DOUBLE selects the doubleValue member.
                    valid_percent(unsafe { item.FmtValue.Anonymous.doubleValue })
                } else {
                    None
                };
                rows.push(EngineRow {
                    pid,
                    engine,
                    utilization,
                });
            }
            return Some(rows);
        }
        None
    }
}

impl Drop for WindowsGpuSampler {
    fn drop(&mut self) {
        if !self.query.is_null() {
            // SAFETY: query belongs exclusively to this sampler. Closing it
            // also removes all counters; no externally owned handle is used.
            unsafe { PdhCloseQuery(self.query) };
        }
    }
}

fn read_name(name: *const u16, buffer: &[u64], bytes: usize) -> Option<String> {
    let start = buffer.as_ptr() as usize;
    let address = name as usize;
    let offset = address.checked_sub(start)?;
    if offset >= bytes || offset % size_of::<u16>() != 0 {
        return None;
    }
    let remaining = ((bytes - offset) / size_of::<u16>()).min(MAX_COUNTER_NAME);
    // SAFETY: pointer alignment and full read extent were checked against the
    // still-live PDH buffer; searching never reads past that allocation.
    let units = unsafe { std::slice::from_raw_parts(name, remaining) };
    let length = units.iter().position(|unit| *unit == 0)?;
    String::from_utf16(&units[..length]).ok()
}

#[derive(Debug)]
struct EngineRow {
    pid: u32,
    engine: String,
    utilization: Option<f64>,
}

fn parse_engine_instance(name: &str) -> Option<(u32, String)> {
    let (pid, adapter_and_engine) = name.strip_prefix("pid_")?.split_once("_luid_")?;
    let pid = pid.parse::<u32>().ok().filter(|pid| *pid > 0)?;
    let (adapter, engine) = adapter_and_engine.split_once("_phys_")?;
    let (luid_high, luid_low) = adapter.split_once('_')?;
    for part in [luid_high, luid_low] {
        let hex = part.strip_prefix("0x")?;
        if hex.is_empty() || hex.len() > 8 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
    }
    let (physical, engine) = engine.split_once("_eng_")?;
    let physical = physical.parse::<u32>().ok()?;
    let (number, kind) = engine.split_once("_engtype_")?;
    let number = number.parse::<u32>().ok()?;
    if kind.is_empty() {
        return None;
    }
    Some((pid, format!("{adapter}_phys_{physical}_eng_{number}")))
}

fn valid_percent(value: f64) -> Option<f64> {
    (value.is_finite() && value >= 0.0).then_some(value.min(100.0))
}

#[derive(Default)]
struct EngineTotals {
    by_engine: HashMap<String, f64>,
    seen: HashSet<(u32, String)>,
    incomplete: bool,
}

impl EngineTotals {
    fn add(&mut self, row: &EngineRow) {
        if !self.seen.insert((row.pid, row.engine.clone())) {
            self.incomplete = true;
            return;
        }
        if let Some(value) = row.utilization {
            *self.by_engine.entry(row.engine.clone()).or_default() += value;
        } else {
            self.incomplete = true;
        }
    }

    fn busiest(&self) -> Option<f32> {
        if self.incomplete {
            return None;
        }
        self.by_engine
            .values()
            .copied()
            .reduce(f64::max)
            .map(|value| value.clamp(0.0, 100.0) as f32)
    }
}

fn aggregate_engines(
    rows: &[EngineRow],
    app_pids: &HashSet<u32>,
    model_pids: &HashSet<u32>,
) -> GpuEngineSample {
    let mut total = EngineTotals::default();
    let mut app = EngineTotals::default();
    let mut model = EngineTotals::default();
    for row in rows {
        total.add(row);
        if model_pids.contains(&row.pid) {
            model.add(row);
        } else if app_pids.contains(&row.pid) {
            app.add(row);
        }
    }
    // Task Manager likewise uses the busiest engine, not a sum of independent
    // engines or an average that would hide a saturated compute engine:
    // https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/
    GpuEngineSample {
        total_percent: total.busiest(),
        app_percent: app.busiest(),
        model_percent: model.busiest(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, engine: &str, utilization: Option<f64>) -> EngineRow {
        EngineRow {
            pid,
            engine: engine.into(),
            utilization,
        }
    }

    #[test]
    fn engine_key_keeps_adapter_and_physical_device_identity() {
        assert_eq!(
            parse_engine_instance("pid_42_luid_0x00000000_0x00000123_phys_1_eng_3_engtype_Compute"),
            Some((42, "0x00000000_0x00000123_phys_1_eng_3".into()))
        );
        for invalid in [
            "_Total",
            "pid_0_luid_0x0_0x1_phys_0_eng_0_engtype_3D",
            "pid_42_luid_bad_phys_0_eng_0_engtype_3D",
            "pid_42_luid_0x0_0x1_phys_bad_eng_0_engtype_3D",
            "pid_42_luid_0x0_0x1_phys_0_eng_0_engtype_",
        ] {
            assert_eq!(parse_engine_instance(invalid), None);
        }
    }

    #[test]
    fn processes_sum_within_one_engine_but_independent_engines_do_not_sum() {
        let rows = [
            row(1, "adapter_a_engine_0", Some(20.0)),
            row(2, "adapter_a_engine_0", Some(30.0)),
            row(1, "adapter_a_engine_1", Some(80.0)),
            row(3, "adapter_a_engine_0", Some(10.0)),
            row(4, "adapter_b_engine_0", Some(90.0)),
        ];
        assert_eq!(
            aggregate_engines(&rows, &HashSet::from([1, 2]), &HashSet::from([3])),
            GpuEngineSample {
                total_percent: Some(90.0),
                app_percent: Some(80.0),
                model_percent: Some(10.0),
            }
        );
    }

    #[test]
    fn model_is_not_counted_again_in_app_even_if_pid_sets_overlap() {
        let result = aggregate_engines(
            &[row(1, "a", Some(20.0)), row(2, "a", Some(30.0))],
            &HashSet::from([1, 2]),
            &HashSet::from([2]),
        );
        assert_eq!(result.app_percent, Some(20.0));
        assert_eq!(result.model_percent, Some(30.0));
    }

    #[test]
    fn missing_process_counters_are_unavailable_and_measured_zero_is_preserved() {
        let result = aggregate_engines(
            &[row(1, "a", Some(0.0))],
            &HashSet::from([1]),
            &HashSet::from([2]),
        );
        assert_eq!(result.total_percent, Some(0.0));
        assert_eq!(result.app_percent, Some(0.0));
        assert_eq!(result.model_percent, None);
        assert_eq!(
            aggregate_engines(&[], &HashSet::new(), &HashSet::new()),
            GpuEngineSample::default()
        );
    }

    #[test]
    fn incomplete_or_duplicate_rows_invalidate_only_affected_scopes() {
        let result = aggregate_engines(
            &[row(1, "a", Some(20.0)), row(2, "a", None)],
            &HashSet::from([1]),
            &HashSet::from([2]),
        );
        assert_eq!(result.total_percent, None);
        assert_eq!(result.app_percent, Some(20.0));
        assert_eq!(result.model_percent, None);
        let duplicate = aggregate_engines(
            &[row(1, "a", Some(20.0)), row(1, "a", Some(20.0))],
            &HashSet::from([1]),
            &HashSet::new(),
        );
        assert_eq!(duplicate.total_percent, None);
        assert_eq!(duplicate.app_percent, None);
    }

    #[test]
    fn malformed_values_are_missing_and_engine_sums_remain_on_percent_scale() {
        assert_eq!(valid_percent(f64::NAN), None);
        assert_eq!(valid_percent(f64::INFINITY), None);
        assert_eq!(valid_percent(-1.0), None);
        assert_eq!(valid_percent(0.0), Some(0.0));
        assert_eq!(valid_percent(101.0), Some(100.0));
        let result = aggregate_engines(
            &[row(1, "a", Some(70.0)), row(2, "a", Some(50.0))],
            &HashSet::from([1, 2]),
            &HashSet::new(),
        );
        assert_eq!(result.app_percent, Some(100.0));
    }

    #[test]
    #[ignore = "read-only WDDM hardware probe; run explicitly"]
    fn windows_gpu_counter_probe() {
        let sampler = WindowsGpuSampler::start().expect("WDDM GPU engine counters available");
        std::thread::sleep(std::time::Duration::from_millis(500));
        let sample = sampler.finish(&HashSet::from([std::process::id()]), &HashSet::new());
        let total = sample.total_percent.expect("complete GPU engine sample");
        assert!((0.0..=100.0).contains(&total));
        assert_eq!(sample.model_percent, None);
        println!(
            "WDDM read-only probe: total={total:.2}%, own_process_counter_available={}",
            sample.app_percent.is_some()
        );
    }
}
