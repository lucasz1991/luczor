//! Read-only classification of the physical disks backing the actual model path.
//! No serial numbers, volume GUIDs, file contents, commands or paths leave this module.
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StorageSnapshot {
    pub status: String,
    pub storage_type: String,
    pub bus_types: Vec<String>,
    /// Windows volume drive type; a USB SSD may report fixed but never fixed NVMe.
    pub fixed: Option<bool>,
    pub removable: Option<bool>,
    pub total_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    pub reason_code: Option<String>,
}

impl StorageSnapshot {
    pub(super) fn fixed_nvme(&self) -> bool {
        self.status == "ready"
            && self.storage_type == "nvme"
            && self.fixed == Some(true)
            && self.removable == Some(false)
            && self.bus_types == ["nvme"]
    }

    fn unavailable(reason: &str) -> Self {
        Self {
            status: "unavailable".into(),
            storage_type: "unknown".into(),
            bus_types: Vec::new(),
            fixed: None,
            removable: None,
            total_bytes: None,
            available_bytes: None,
            reason_code: Some(reason.into()),
        }
    }
}

pub(super) fn inspect_storage(path: &Path) -> StorageSnapshot {
    if !path.is_absolute() {
        return StorageSnapshot::unavailable("storage_path_not_absolute");
    }
    #[cfg(windows)]
    {
        windows::inspect_bounded(path)
    }
    #[cfg(not(windows))]
    {
        StorageSnapshot::unavailable("storage_bus_probe_unsupported")
    }
}

#[cfg(any(windows, test))]
#[derive(Debug)]
struct DiskEvidence {
    bus: &'static str,
    removable: bool,
    seek_penalty: Option<bool>,
}

#[cfg(any(windows, test))]
fn media_type(disk: &DiskEvidence) -> &'static str {
    if disk.bus == "nvme" {
        "nvme"
    } else {
        match disk.seek_penalty {
            Some(true) => "hdd",
            Some(false) => "ssd",
            None => "unknown",
        }
    }
}

#[cfg(any(windows, test))]
fn classify_disks(disks: &[DiskEvidence], volume_fixed: bool) -> StorageSnapshot {
    if disks.is_empty() {
        return StorageSnapshot::unavailable("storage_disk_mapping_unavailable");
    }
    let mut buses: Vec<_> = disks.iter().map(|disk| disk.bus.to_string()).collect();
    buses.sort();
    buses.dedup();
    let mut media: Vec<_> = disks.iter().map(media_type).collect();
    media.sort();
    media.dedup();
    let storage_type = if media.contains(&"unknown") {
        "unknown"
    } else if media.len() == 1 {
        media[0]
    } else {
        "mixed"
    };
    let known = storage_type != "unknown" && !buses.iter().any(|bus| bus == "unknown");
    StorageSnapshot {
        status: if known { "ready" } else { "partial" }.into(),
        storage_type: storage_type.into(),
        bus_types: buses,
        fixed: Some(volume_fixed && disks.iter().all(|disk| !disk.removable)),
        removable: Some(!volume_fixed || disks.iter().any(|disk| disk.removable)),
        total_bytes: None,
        available_bytes: None,
        reason_code: (!known).then(|| "storage_media_unknown".into()),
    }
}

#[cfg(windows)]
fn bus_name(bus: i32) -> &'static str {
    match bus {
        1 => "scsi",
        2 => "atapi",
        3 => "ata",
        4 => "ieee1394",
        5 => "ssa",
        6 => "fibre",
        7 => "usb",
        8 => "raid",
        9 => "iscsi",
        10 => "sas",
        11 => "sata",
        12 => "sd",
        13 => "mmc",
        14 => "virtual",
        15 => "file_backed_virtual",
        16 => "storage_spaces",
        17 => "nvme",
        18 => "scm",
        19 => "ufs",
        _ => "unknown",
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::c_void;
    use std::mem::{offset_of, size_of};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetDiskFreeSpaceExW, GetDriveTypeW, GetVolumeNameForVolumeMountPointW,
        GetVolumePathNameW, FILE_SHARE_READ, FILE_SHARE_WRITE,
        IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Ioctl::{
        PropertyStandardQuery, StorageDeviceProperty, StorageDeviceSeekPenaltyProperty,
        DEVICE_SEEK_PENALTY_DESCRIPTOR, DISK_EXTENT, IOCTL_STORAGE_QUERY_PROPERTY,
        STORAGE_DEVICE_DESCRIPTOR, STORAGE_PROPERTY_QUERY, VOLUME_DISK_EXTENTS,
    };
    use windows_sys::Win32::System::WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOVABLE};
    use windows_sys::Win32::System::IO::{CancelSynchronousIo, DeviceIoControl};

    const MAX_PATH_UNITS: usize = 32_768;
    const MAX_IOCTL_BYTES: usize = 64 * 1024;
    const MAX_EXTENTS: usize = 128;
    const DEADLINE: Duration = Duration::from_secs(3);
    static ACTIVE: AtomicBool = AtomicBool::new(false);

    struct ActiveGuard;
    impl Drop for ActiveGuard {
        fn drop(&mut self) {
            ACTIVE.store(false, Ordering::Release);
        }
    }

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            // This wrapper owns only successful CreateFileW handles.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub(super) fn inspect_bounded(path: &Path) -> StorageSnapshot {
        if !local_volume_path(path) {
            return StorageSnapshot::unavailable("storage_path_not_local_volume");
        }
        if ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return StorageSnapshot::unavailable("storage_probe_busy");
        }
        let path = path.to_path_buf();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("luczor-storage-probe".into())
            .spawn(move || {
                let _active = ActiveGuard;
                let result = inspect_path(&path, &worker_cancelled)
                    .unwrap_or_else(StorageSnapshot::unavailable);
                drop(_active);
                let _ = sender.send(result);
            });
        let Ok(worker) = worker else {
            ACTIVE.store(false, Ordering::Release);
            return StorageSnapshot::unavailable("storage_probe_worker_unavailable");
        };
        match receiver.recv_timeout(DEADLINE) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                cancelled.store(true, Ordering::Release);
                // Cancellation is best effort and never waits for a stalled driver. Buffers
                // and handles stay owned by the single worker until that I/O actually ends.
                unsafe { CancelSynchronousIo(worker.as_raw_handle() as HANDLE) };
                StorageSnapshot::unavailable(match error {
                    mpsc::RecvTimeoutError::Timeout => "storage_probe_timeout",
                    mpsc::RecvTimeoutError::Disconnected => "storage_probe_worker_unavailable",
                })
            }
        }
    }

    pub(super) fn local_volume_path(path: &Path) -> bool {
        use std::path::{Component, Prefix};
        match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(_) | Prefix::VerbatimDisk(_) => true,
                Prefix::Verbatim(volume) => volume.to_str().is_some_and(|name| {
                    name.strip_prefix("Volume{")
                        .and_then(|value| value.strip_suffix('}'))
                        .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok())
                }),
                _ => false,
            },
            _ => false,
        }
    }

    fn check(cancelled: &AtomicBool) -> Result<(), &'static str> {
        if cancelled.load(Ordering::Acquire) {
            Err("storage_probe_timeout")
        } else {
            Ok(())
        }
    }

    fn wide_path(path: &Path) -> Result<Vec<u16>, &'static str> {
        let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
        if value.len() >= MAX_PATH_UNITS || value.contains(&0) {
            return Err("storage_path_invalid");
        }
        value.push(0);
        Ok(value)
    }

    fn canonical_existing_ancestor(
        path: &Path,
        cancelled: &AtomicBool,
    ) -> Result<PathBuf, &'static str> {
        for candidate in path.ancestors().take(128) {
            check(cancelled)?;
            match std::fs::canonicalize(candidate) {
                Ok(path) => return Ok(path),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("storage_path_unavailable"),
            }
        }
        Err("storage_path_unavailable")
    }

    fn open_device(path: &[u16], cancelled: &AtomicBool) -> Result<Handle, &'static str> {
        check(cancelled)?;
        // Desired access zero opens metadata/query access only. No data or write access.
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            Err("storage_device_not_queryable")
        } else {
            Ok(Handle(handle))
        }
    }

    fn ioctl(
        handle: &Handle,
        code: u32,
        query: Option<&STORAGE_PROPERTY_QUERY>,
        cancelled: &AtomicBool,
    ) -> Result<Vec<u8>, &'static str> {
        check(cancelled)?;
        let mut output = vec![0_u8; MAX_IOCTL_BYTES];
        let mut written = 0_u32;
        let (input, input_len) = query.map_or((null(), 0), |query| {
            (
                query as *const _ as *const c_void,
                size_of::<STORAGE_PROPERTY_QUERY>() as u32,
            )
        });
        let success = unsafe {
            DeviceIoControl(
                handle.0,
                code,
                input,
                input_len,
                output.as_mut_ptr() as *mut c_void,
                output.len() as u32,
                &mut written,
                null_mut(),
            )
        };
        check(cancelled)?;
        // Partial results are never classified. A larger/spanned layout stays unknown.
        if success == 0 || written as usize > output.len() {
            return Err("storage_query_unavailable");
        }
        output.truncate(written as usize);
        Ok(output)
    }

    fn inspect_path(path: &Path, cancelled: &AtomicBool) -> Result<StorageSnapshot, &'static str> {
        let canonical = canonical_existing_ancestor(path, cancelled)?;
        let canonical = wide_path(&canonical)?;
        let mut volume_mount = vec![0_u16; MAX_PATH_UNITS];
        check(cancelled)?;
        if unsafe {
            GetVolumePathNameW(
                canonical.as_ptr(),
                volume_mount.as_mut_ptr(),
                volume_mount.len() as u32,
            )
        } == 0
        {
            return Err("storage_volume_unavailable");
        }
        check(cancelled)?;
        let drive_type = unsafe { GetDriveTypeW(volume_mount.as_ptr()) };
        if drive_type != DRIVE_FIXED && drive_type != DRIVE_REMOVABLE {
            return Err("storage_volume_not_local_disk");
        }
        let mut volume_name = vec![0_u16; 128];
        check(cancelled)?;
        if unsafe {
            GetVolumeNameForVolumeMountPointW(
                volume_mount.as_ptr(),
                volume_name.as_mut_ptr(),
                volume_name.len() as u32,
            )
        } == 0
        {
            return Err("storage_volume_unavailable");
        }
        let length = volume_name
            .iter()
            .position(|unit| *unit == 0)
            .ok_or("storage_volume_invalid")?;
        if length == 0 {
            return Err("storage_volume_invalid");
        }
        volume_name.truncate(length);
        if volume_name.last() == Some(&(b'\\' as u16)) {
            volume_name.pop();
        }
        volume_name.push(0);
        let volume = open_device(&volume_name, cancelled)?;
        let extents = ioctl(
            &volume,
            IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS,
            None,
            cancelled,
        )?;
        let disks = parse_extents(&extents)?;
        let mut evidence = Vec::with_capacity(disks.len());
        for number in disks {
            let device = wide_path(Path::new(&format!(r"\\.\PhysicalDrive{number}")))?;
            let handle = open_device(&device, cancelled)?;
            let descriptor = ioctl(
                &handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                Some(&STORAGE_PROPERTY_QUERY {
                    PropertyId: StorageDeviceProperty,
                    QueryType: PropertyStandardQuery,
                    AdditionalParameters: [0],
                }),
                cancelled,
            )?;
            let (bus, removable) = parse_device_descriptor(&descriptor)?;
            let seek_penalty = ioctl(
                &handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                Some(&STORAGE_PROPERTY_QUERY {
                    PropertyId: StorageDeviceSeekPenaltyProperty,
                    QueryType: PropertyStandardQuery,
                    AdditionalParameters: [0],
                }),
                cancelled,
            )
            .ok()
            .and_then(|bytes| parse_seek_penalty(&bytes));
            evidence.push(DiskEvidence {
                bus: bus_name(bus),
                removable,
                seek_penalty,
            });
        }
        check(cancelled)?;
        let mut snapshot = classify_disks(&evidence, drive_type == DRIVE_FIXED);
        let mut available = 0;
        let mut total = 0;
        if unsafe {
            GetDiskFreeSpaceExW(
                volume_mount.as_ptr(),
                &mut available,
                &mut total,
                null_mut(),
            )
        } != 0
            && total > 0
        {
            snapshot.available_bytes = Some(available.min(total));
            snapshot.total_bytes = Some(total);
        }
        check(cancelled)?;
        Ok(snapshot)
    }

    fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
        Some(u32::from_le_bytes(
            bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
        ))
    }

    pub(super) fn parse_extents(bytes: &[u8]) -> Result<Vec<u32>, &'static str> {
        let count = u32_at(bytes, 0).ok_or("storage_extents_invalid")? as usize;
        if count == 0 || count > MAX_EXTENTS {
            return Err("storage_extents_out_of_bounds");
        }
        let start = offset_of!(VOLUME_DISK_EXTENTS, Extents);
        let needed = start
            .checked_add(count * size_of::<DISK_EXTENT>())
            .ok_or("storage_extents_invalid")?;
        if needed > bytes.len() {
            return Err("storage_extents_incomplete");
        }
        let mut disks = Vec::with_capacity(count);
        for index in 0..count {
            let offset = start + index * size_of::<DISK_EXTENT>();
            let number = u32_at(bytes, offset).ok_or("storage_extents_invalid")?;
            disks.push(number);
        }
        disks.sort_unstable();
        disks.dedup();
        Ok(disks)
    }

    pub(super) fn parse_device_descriptor(bytes: &[u8]) -> Result<(i32, bool), &'static str> {
        let minimum = offset_of!(STORAGE_DEVICE_DESCRIPTOR, RawPropertiesLength) + 4;
        let reported_size = u32_at(bytes, 4).ok_or("storage_descriptor_invalid")? as usize;
        if bytes.len() < minimum || reported_size < minimum || reported_size > bytes.len() {
            return Err("storage_descriptor_incomplete");
        }
        let removable = match bytes[offset_of!(STORAGE_DEVICE_DESCRIPTOR, RemovableMedia)] {
            0 => false,
            1 => true,
            _ => return Err("storage_descriptor_invalid"),
        };
        let bus = u32_at(bytes, offset_of!(STORAGE_DEVICE_DESCRIPTOR, BusType))
            .ok_or("storage_descriptor_invalid")? as i32;
        Ok((bus, removable))
    }

    pub(super) fn parse_seek_penalty(bytes: &[u8]) -> Option<bool> {
        let offset = offset_of!(DEVICE_SEEK_PENALTY_DESCRIPTOR, IncursSeekPenalty);
        if (u32_at(bytes, 4)? as usize) < offset + 1 {
            return None;
        }
        match bytes.get(offset)? {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_all_fixed_nvme_extents_satisfy_required_location() {
        let nvme = || DiskEvidence {
            bus: "nvme",
            removable: false,
            seek_penalty: Some(false),
        };
        assert!(classify_disks(&[nvme(), nvme()], true).fixed_nvme());
        assert!(!classify_disks(&[nvme()], false).fixed_nvme());
        assert!(!classify_disks(
            &[
                nvme(),
                DiskEvidence {
                    bus: "usb",
                    removable: false,
                    seek_penalty: Some(false)
                }
            ],
            true
        )
        .fixed_nvme());
        assert!(!classify_disks(&[], true).fixed_nvme());
    }

    #[test]
    fn usb_ssd_and_sata_hdd_are_not_guessed_from_volume_drive_type() {
        let usb = classify_disks(
            &[DiskEvidence {
                bus: "usb",
                removable: false,
                seek_penalty: Some(false),
            }],
            true,
        );
        assert_eq!(usb.storage_type, "ssd");
        assert_eq!(usb.bus_types, ["usb"]);
        assert!(!usb.fixed_nvme());
        let hdd = classify_disks(
            &[DiskEvidence {
                bus: "sata",
                removable: false,
                seek_penalty: Some(true),
            }],
            true,
        );
        assert_eq!(hdd.storage_type, "hdd");
        let unknown = classify_disks(
            &[DiskEvidence {
                bus: "scsi",
                removable: false,
                seek_penalty: None,
            }],
            true,
        );
        assert_eq!(unknown.status, "partial");
        assert_eq!(unknown.storage_type, "unknown");
    }

    #[test]
    fn snapshot_serialization_contains_only_safe_storage_metadata() {
        let value = serde_json::to_value(classify_disks(
            &[DiskEvidence {
                bus: "nvme",
                removable: false,
                seek_penalty: None,
            }],
            true,
        ))
        .unwrap();
        assert_eq!(value["storageType"], "nvme");
        assert_eq!(value["busTypes"], serde_json::json!(["nvme"]));
        assert_eq!(value.as_object().unwrap().len(), 8);
    }

    #[cfg(windows)]
    #[test]
    fn extents_parse_multiple_partitions_without_confusing_partition_and_disk_numbers() {
        use windows_sys::Win32::System::Ioctl::{DISK_EXTENT, VOLUME_DISK_EXTENTS};
        let offset = std::mem::offset_of!(VOLUME_DISK_EXTENTS, Extents);
        let stride = std::mem::size_of::<DISK_EXTENT>();
        let mut bytes = vec![0_u8; offset + stride * 3];
        bytes[0..4].copy_from_slice(&3_u32.to_le_bytes());
        for (index, disk) in [2_u32, 7, 2].iter().enumerate() {
            bytes[offset + stride * index..offset + stride * index + 4]
                .copy_from_slice(&disk.to_le_bytes());
        }
        assert_eq!(windows::parse_extents(&bytes).unwrap(), [2, 7]);
        assert!(windows::parse_extents(&bytes[..bytes.len() - 1]).is_err());
        bytes[0..4].copy_from_slice(&129_u32.to_le_bytes());
        assert!(windows::parse_extents(&bytes).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn incomplete_or_malformed_storage_descriptors_do_not_invent_media() {
        use windows_sys::Win32::System::Ioctl::STORAGE_DEVICE_DESCRIPTOR;
        let mut bytes = vec![0_u8; std::mem::size_of::<STORAGE_DEVICE_DESCRIPTOR>()];
        let length = bytes.len() as u32;
        bytes[4..8].copy_from_slice(&length.to_le_bytes());
        let bus = std::mem::offset_of!(STORAGE_DEVICE_DESCRIPTOR, BusType);
        bytes[bus..bus + 4].copy_from_slice(&17_u32.to_le_bytes());
        assert_eq!(
            windows::parse_device_descriptor(&bytes).unwrap(),
            (17, false)
        );
        assert!(windows::parse_device_descriptor(&bytes[..10]).is_err());
        bytes[std::mem::offset_of!(STORAGE_DEVICE_DESCRIPTOR, RemovableMedia)] = 2;
        assert!(windows::parse_device_descriptor(&bytes).is_err());
        assert_eq!(windows::parse_seek_penalty(&[0; 8]), None);
    }

    #[cfg(windows)]
    #[test]
    fn supports_extended_local_paths_but_rejects_remote_and_raw_device_targets() {
        assert!(windows::local_volume_path(Path::new(
            r"C:\models\model.gguf"
        )));
        assert!(windows::local_volume_path(Path::new(
            r"\\?\C:\models\model.gguf"
        )));
        assert!(!windows::local_volume_path(Path::new(
            r"\\server\share\model.gguf"
        )));
        assert!(!windows::local_volume_path(Path::new(
            r"\\?\UNC\server\share\model.gguf"
        )));
        assert!(!windows::local_volume_path(Path::new(
            r"\\.\PhysicalDrive0"
        )));
        assert!(!windows::local_volume_path(Path::new(
            r"\\?\GLOBALROOT\Device\HarddiskVolume1"
        )));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Explicit read-only hardware smoke; reads metadata only for configured drive roots"]
    fn storage_probe_live_readonly() {
        for path in [r"C:\", r"\\?\C:\", r"D:\", r"E:\"] {
            let snapshot = inspect_storage(Path::new(path));
            println!("{path}: {}", serde_json::to_string(&snapshot).unwrap());
            assert_ne!(
                snapshot.reason_code.as_deref(),
                Some("storage_path_not_absolute")
            );
        }
        if let Some(path) = std::env::var_os("LUCZOR_STORAGE_PROBE_PATH") {
            let path = std::path::PathBuf::from(path);
            assert!(
                path.is_file(),
                "The explicit model metadata smoke requires an existing file."
            );
            let snapshot = inspect_storage(&path);
            println!(
                "confirmed-model-file: {}",
                serde_json::to_string(&snapshot).unwrap()
            );
            assert_eq!(snapshot.status, "ready");
        }
    }
}
