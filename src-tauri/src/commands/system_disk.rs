//! One bounded observation of the application's volume; no directory traversal.
use serde::Serialize;
use sysinfo::{DiskKind, Disks};

#[derive(Debug, Clone, Serialize, Default)]
pub(crate) struct DiskSample {
    pub mount: String,
    pub kind: &'static str,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub busy_percent: Option<f32>,
    pub read_percent: Option<f32>,
    pub write_percent: Option<f32>,
}

pub(crate) struct DiskSampler {
    sample: DiskSample,
    #[cfg(windows)]
    counters: Option<windows::Counters>,
}

impl DiskSampler {
    pub(super) fn start() -> Option<Self> {
        let exe = std::env::current_exe().ok()?;
        let disks = Disks::new_with_refreshed_list();
        let disk = disks
            .list()
            .iter()
            .filter(|disk| exe.starts_with(disk.mount_point()))
            .max_by_key(|disk| disk.mount_point().as_os_str().len())?;
        let mount = disk.mount_point().to_str()?.to_string();
        let sample = DiskSample {
            mount: mount.clone(),
            kind: match disk.kind() {
                DiskKind::SSD => "ssd",
                DiskKind::HDD => "hdd",
                _ => "unknown",
            },
            total_bytes: disk.total_space(),
            used_bytes: disk.total_space().saturating_sub(disk.available_space()),
            ..Default::default()
        };
        Some(Self {
            sample,
            #[cfg(windows)]
            counters: windows::Counters::start(&mount),
        })
    }

    pub(super) fn finish(mut self) -> DiskSample {
        #[cfg(windows)]
        if let Some(counters) = self.counters {
            let (busy, read, write) = counters.finish();
            self.sample.busy_percent = busy;
            self.sample.read_percent = read;
            self.sample.write_percent = write;
        }
        self.sample
    }
}

#[cfg(windows)]
mod windows {
    use std::ptr;
    use windows_sys::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterValue,
        PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE,
        PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
    };
    pub(super) struct Counters {
        query: PDH_HQUERY,
        handles: [PDH_HCOUNTER; 3],
    }
    pub(super) fn percent(value: f64) -> Option<f32> {
        value.is_finite().then(|| value.clamp(0.0, 100.0) as f32)
    }
    impl Counters {
        pub(super) fn start(mount: &str) -> Option<Self> {
            let drive = mount.trim_end_matches('\\');
            if drive.len() != 2
                || !drive.as_bytes()[0].is_ascii_alphabetic()
                || !drive.ends_with(':')
            {
                return None;
            }
            let mut result = Self {
                query: ptr::null_mut(),
                handles: [ptr::null_mut(); 3],
            };
            // SAFETY: valid out pointers and owned query; Drop closes all paths.
            if unsafe { PdhOpenQueryW(ptr::null(), 0, &mut result.query) } != 0 {
                return None;
            }
            for (index, name) in ["% Idle Time", "% Disk Read Time", "% Disk Write Time"]
                .iter()
                .enumerate()
            {
                let path: Vec<u16> = format!("\\LogicalDisk({drive})\\{name}\0")
                    .encode_utf16()
                    .collect();
                // SAFETY: NUL-terminated path, query and handle storage remain alive.
                if unsafe {
                    PdhAddEnglishCounterW(
                        result.query,
                        path.as_ptr(),
                        0,
                        &mut result.handles[index],
                    )
                } != 0
                {
                    return None;
                }
            }
            // SAFETY: first sample of the owned query.
            if unsafe { PdhCollectQueryData(result.query) } != 0 {
                return None;
            }
            Some(result)
        }
        pub(super) fn finish(&self) -> (Option<f32>, Option<f32>, Option<f32>) {
            // SAFETY: query is owned and valid until Drop.
            if unsafe { PdhCollectQueryData(self.query) } != 0 {
                return (None, None, None);
            }
            let read = |index: usize| {
                // SAFETY: zero initializes the C output structure, populated below.
                let mut value: PDH_FMT_COUNTERVALUE = unsafe { std::mem::zeroed() };
                // SAFETY: valid counter and output; PDH_FMT_DOUBLE selects doubleValue.
                let result = unsafe {
                    PdhGetFormattedCounterValue(
                        self.handles[index],
                        PDH_FMT_DOUBLE,
                        ptr::null_mut(),
                        &mut value,
                    )
                };
                if result != 0
                    || !matches!(value.CStatus, PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA)
                {
                    return None;
                }
                // SAFETY: successful format call above selected this union field.
                percent(unsafe { value.Anonymous.doubleValue })
            };
            (read(0).map(|idle| 100.0 - idle), read(1), read(2))
        }
    }
    impl Drop for Counters {
        fn drop(&mut self) {
            if !self.query.is_null() {
                // SAFETY: exclusively owned query; also frees its counters.
                unsafe { PdhCloseQuery(self.query) };
            }
        }
    }
    #[cfg(test)]
    mod tests {
        #[test]
        fn disk_percent_preserves_missing_values_and_zero() {
            assert_eq!(super::percent(f64::NAN), None);
            assert_eq!(super::percent(f64::INFINITY), None);
            assert_eq!(super::percent(0.0), Some(0.0));
            assert_eq!(super::percent(102.0), Some(100.0));
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "explicit read-only device observation"]
    fn observe_app_volume() {
        let sampler = super::DiskSampler::start().expect("App volume available");
        std::thread::sleep(std::time::Duration::from_millis(250));
        let sample = sampler.finish();
        assert!(sample.total_bytes > 0);
        assert!(sample.used_bytes <= sample.total_bytes);
        println!("{}", serde_json::to_string(&sample).unwrap());
    }
}
