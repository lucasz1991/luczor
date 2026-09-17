use super::*;

// The signed catalog pins every downloaded byte; this server only transports it.
const ASSET_BASE: &str = "https://luczor.follow-flow.de/api/v1/local-model/assets";
const MAX_RUNTIME_BYTES: u64 = 1024 * 1024 * 1024;

pub(super) fn ensure(
    app: &AppHandle,
    model: &ModelRelease,
    cancel: &AtomicBool,
) -> Result<(PathBuf, PathBuf), String> {
    let artifact = model.artifact.as_ref().ok_or("Missing model artifact.")?;
    let runtime = model.runtime.as_ref().ok_or("Missing runtime artifact.")?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Local-model data directory unavailable.")?
        .join("local-model/installed");
    let runtime_dir = root.join(&runtime.sha256);
    super::reject_runtime_reparse_points(&runtime_dir)?;
    fs::create_dir_all(&runtime_dir)
        .map_err(|_| "Cannot create local-model installation directory.")?;
    if !root.join(format!("{}.gguf", model.id)).exists() {
        ensure_model_storage(
            &runtime_dir,
            artifact,
            model
                .capacity_policy
                .min_storage_free_bytes
                .unwrap_or(0)
                .saturating_add(MAX_RUNTIME_BYTES),
        )?;
    }
    let binary = runtime_dir.join(if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    });
    download(
        &format!("{ASSET_BASE}/{}", runtime.sha256),
        &binary,
        &runtime.sha256,
        MAX_RUNTIME_BYTES,
        None,
        cancel,
    )?;
    validate_platform_binary(&binary)?;
    ensure_support_files(&binary, runtime, cancel)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot make verified local runtime executable.")?;
    }
    let model_path = root.join(format!("{}.gguf", model.id));
    download(
        &artifact.url,
        &model_path,
        &artifact.sha256,
        artifact.size_bytes,
        Some(artifact.size_bytes),
        cancel,
    )?;
    super::persist_runtime_paths(app, &binary, &root)?;
    Ok((binary, model_path))
}

pub(super) fn ensure_support_files(
    binary: &Path,
    runtime: &RuntimeArtifact,
    cancel: &AtomicBool,
) -> Result<(), String> {
    gpu_runtime::validate_runtime_metadata(runtime)?;
    let directory = binary
        .parent()
        .ok_or("Verified runtime directory is unavailable.")?;
    for file in runtime.files.as_deref().unwrap_or_default() {
        let suffix = if cfg!(windows) {
            ".dll"
        } else if cfg!(target_os = "linux") {
            ".so"
        } else {
            ".dylib"
        };
        if !file.name.to_ascii_lowercase().ends_with(suffix) {
            return Err("The signed runtime libraries do not match this platform.".into());
        }
        download(
            &format!("{ASSET_BASE}/{}", file.sha256),
            &directory.join(&file.name),
            &file.sha256,
            MAX_RUNTIME_BYTES,
            None,
            cancel,
        )?;
    }
    Ok(())
}

fn validate_platform_binary(path: &Path) -> Result<(), String> {
    let mut header = [0u8; 20];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|_| "Cannot read installed local runtime.")?;
    if cfg!(target_os = "windows") {
        if &header[..2] != b"MZ" {
            return Err("The server runtime does not match this Windows platform.".into());
        }
    } else {
        let machine = u16::from_le_bytes([header[18], header[19]]);
        let expected = if cfg!(target_arch = "x86_64") {
            62
        } else if cfg!(target_arch = "aarch64") {
            183
        } else {
            0
        };
        if &header[..4] != b"\x7fELF"
            || header[4] != 2
            || header[5] != 1
            || expected == 0
            || machine != expected
        {
            return Err("The server runtime does not match this Linux architecture.".into());
        }
    }
    Ok(())
}

fn download(
    url: &str,
    destination: &Path,
    hash: &str,
    limit: u64,
    exact: Option<u64>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Model installation cancelled.".into());
    }
    super::reject_runtime_reparse_points(destination)?;
    if destination.exists() {
        let mut file =
            File::open(destination).map_err(|_| "Cannot read installed model resource.")?;
        let size = file
            .metadata()
            .map_err(|_| "Cannot inspect installed resource.")?
            .len();
        if size > limit || exact.is_some_and(|expected| size != expected) {
            return Err("Installed model resource size mismatch.".into());
        }
        if sha256_open_file_cancellable(&mut file, cancel)? != hash {
            return Err("Installed model resource checksum mismatch.".into());
        }
        return Ok(());
    }
    let url = reqwest::Url::parse(url).map_err(|_| "Invalid model download URL.")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Model downloads require HTTPS without embedded credentials.".into());
    }
    let temporary = destination.with_extension(format!("part-{}", Uuid::new_v4()));
    let result = (|| {
        let client = Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::limited(5))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(1800))
            .build()
            .map_err(|_| "Cannot initialize model download.")?;
        let mut response = client
            .get(url)
            .send()
            .map_err(|_| "Model resource download failed.")?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(
                "The server has not provided the signed local runtime or model resource.".into(),
            );
        }
        if response.content_length().is_some_and(|size| size > limit) {
            return Err("Model resource exceeds signed download limit.".into());
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "Cannot create model download file.")?;
        let mut digest = Sha256::new();
        let mut size = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("Model installation cancelled.".into());
            }
            let count = response
                .read(&mut buffer)
                .map_err(|_| "Model download interrupted.")?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > limit {
                return Err("Model resource exceeds signed download limit.".into());
            }
            output
                .write_all(&buffer[..count])
                .map_err(|_| "Insufficient storage for model download.")?;
            digest.update(&buffer[..count]);
        }
        if exact.is_some_and(|expected| expected != size)
            || format!("{:x}", digest.finalize()) != hash
        {
            return Err("Downloaded model resource does not match the signed manifest.".into());
        }
        output
            .sync_all()
            .map_err(|_| "Cannot persist model download.")?;
        drop(output);
        // Exclusive publication prevents overwriting a file created by another operation.
        fs::hard_link(&temporary, destination)
            .map_err(|_| "Cannot publish verified model resource.")?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn support_install_checks_platform_names_hashes_and_existing_cache() {
        let root = std::env::temp_dir().join(format!("luczor-support-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let name = if cfg!(windows) {
            "llama-server-impl.dll"
        } else {
            "libllama.so"
        };
        let bytes = b"non executable test fixture";
        fs::write(root.join(name), bytes).unwrap();
        let mut runtime = RuntimeArtifact {
            id: "llama.cpp".into(),
            version: "test".into(),
            sha256: "a".repeat(64),
            min_context_tokens: 1024,
            max_context_tokens: 8192,
            backend: Some("auto".into()),
            files: Some(vec![RuntimeSupportFile {
                name: name.into(),
                sha256: format!("{:x}", Sha256::digest(bytes)),
            }]),
        };
        let cancel = AtomicBool::new(false);
        let binary = root.join("never-executed");
        assert!(ensure_support_files(&binary, &runtime, &cancel).is_ok());
        fs::write(root.join(name), b"tampered").unwrap();
        assert!(ensure_support_files(&binary, &runtime, &cancel)
            .unwrap_err()
            .contains("checksum"));
        runtime.files.as_mut().unwrap()[0].name = "../outside.dll".into();
        assert!(ensure_support_files(&binary, &runtime, &cancel).is_err());
        runtime.files.as_mut().unwrap()[0].name = if cfg!(windows) {
            "libllama.so"
        } else {
            "llama.dll"
        }
        .into();
        assert!(ensure_support_files(&binary, &runtime, &cancel)
            .unwrap_err()
            .contains("platform"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn automatic_maintenance_only_accepts_exact_owned_layout() {
        let root = std::env::temp_dir().join("luczor-owned-layout");
        let executable = if cfg!(windows) {
            "llama-server.exe"
        } else {
            "llama-server"
        };
        let mut config = RuntimePathConfig {
            version: 1,
            model_directory: root.clone(),
            runtime_path: root.join("a".repeat(64)).join(executable),
        };
        assert!(is_managed_runtime_config(&config, &root));
        config.runtime_path = root.join("manual").join(executable);
        assert!(!is_managed_runtime_config(&config, &root));
        config.runtime_path = root.join("a".repeat(64)).join(executable);
        config.model_directory = root.join("custom-models");
        assert!(!is_managed_runtime_config(&config, &root));
    }

    #[test]
    fn cache_requires_hash_size_and_rejects_wrong_architecture() {
        let root = std::env::temp_dir().join(format!("luczor-install-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("resource");
        fs::write(&path, b"test").unwrap();
        let cancel = AtomicBool::new(false);
        let hash = format!("{:x}", Sha256::digest(b"test"));
        assert!(download("https://invalid.invalid", &path, &hash, 4, Some(4), &cancel).is_ok());
        assert!(download("https://invalid.invalid", &path, &hash, 3, None, &cancel).is_err());
        assert!(download(
            "https://invalid.invalid",
            &path,
            &"0".repeat(64),
            4,
            None,
            &cancel
        )
        .is_err());
        fs::write(&path, [0u8; 20]).unwrap();
        assert!(validate_platform_binary(&path).is_err());
        let mut binary = [0u8; 20];
        if cfg!(target_os = "windows") {
            binary[..2].copy_from_slice(b"MZ");
        } else {
            binary[..6].copy_from_slice(b"\x7fELF\x02\x01");
            binary[18] = if cfg!(target_arch = "x86_64") {
                62
            } else {
                183
            };
        }
        fs::write(&path, binary).unwrap();
        assert!(validate_platform_binary(&path).is_ok());
        cancel.store(true, Ordering::SeqCst);
        assert!(download("https://invalid.invalid", &path, &hash, 4, None, &cancel).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
