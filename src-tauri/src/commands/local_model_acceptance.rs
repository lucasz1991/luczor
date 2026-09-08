//! Opt-in, fixed-location acceptance evidence. Never a runtime-control channel.
use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BenchmarkMeasurement {
    pub(super) prompt_tokens_per_second: f64,
    pub(super) decode_tokens_per_second: f64,
    pub(super) first_token_ms: u64,
}

fn enabled(value: Option<&str>) -> bool {
    value == Some("1")
}

fn public_failure(error: &str) -> &'static str {
    if error == resource_runtime::STARTUP_RAM_PRESSURE {
        return "runtime_startup_ram_pressure";
    }
    for code in [
        "resource_config_pending",
        "resource_config_busy",
        "resource_revision_required",
        "resource_revision_mismatch",
        "resource_gpu_selection_changed",
        "resource_gpu_selection_ambiguous",
        "resource_gpu_selection_unavailable",
        "resource_threads_invalid",
        "resource_ram_reserve_invalid",
        "resource_vram_reserve_invalid",
        "resource_thread_controls_unavailable",
        "ram_budget_insufficient",
        "runtime_gpu_measurement_unavailable",
        "runtime_gpu_required_no_offload",
        "cpu_mode_disallowed_by_manifest",
        "runtime_gpu_capacity_unavailable",
        "gpu_full_offload_not_verified",
    ] {
        if error == code {
            return code;
        }
    }
    match error {
        "Local benchmark did not meet the signed capacity thresholds." => {
            "local_benchmark_below_threshold"
        }
        "No compatible GPU runtime satisfies the signed model capacity policy." => {
            "signed_gpu_capacity_unavailable"
        }
        "Available RAM is below the signed model threshold." => "signed_available_ram_insufficient",
        "Total RAM is below the signed model threshold." => "signed_total_ram_insufficient",
        "Resident local model is unavailable for readiness renewal." => {
            "resident_renewal_unavailable"
        }
        "Local operation was cancelled." => "local_prepare_cancelled",
        _ => "local_prepare_failed",
    }
}

pub(super) fn record_opt_in(
    app: &AppHandle,
    elapsed: Duration,
    result: &Result<NativeReadiness, String>,
) {
    if !enabled(
        std::env::var("LUCZOR_RESOURCE_ACCEPTANCE_REPORT")
            .ok()
            .as_deref(),
    ) {
        return;
    }
    // Diagnostic I/O must not change the inference/prepare result.
    let _ = (|| -> Result<(), String> {
        let data = {
            let guard = state().lock().map_err(|_| "acceptance_state_unavailable")?;
            let runtime = guard.runtime.as_ref();
            let acceleration = runtime
                .and_then(|runtime| runtime.acceleration.lock().ok().map(|value| value.clone()));
            json!({
                "schemaVersion": 1,
                "appPid": std::process::id(),
                "runtimePid": runtime.and_then(|runtime| runtime.child.as_ref().map(Child::id)),
                "capturedAtMs": now_ms()? as i64,
                "prepareElapsedMs": elapsed.as_millis().min(u64::MAX as u128) as u64,
                "success": result.is_ok(),
                "reasonCode": result.as_ref().err().map(|error| public_failure(error)),
                "readiness": result.as_ref().ok(),
                "resourceConfig": guard.resource_settings.state,
                "resourcePlan": runtime.map(|runtime| &runtime.resource_plan),
                "acceleration": acceleration,
                "benchmark": runtime.and_then(|runtime| runtime.benchmark.as_ref()),
            })
        };
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|_| "acceptance_directory_unavailable")?
            .join("local-model");
        create_private_directory(&directory)?;
        write_report(&directory, &data)
    })();
}

fn write_report(directory: &Path, data: &Value) -> Result<(), String> {
    let destination = directory.join("resource-acceptance.json");
    let temporary = directory.join(format!(
        "resource-acceptance-{}.tmp",
        Uuid::new_v4().simple()
    ));
    let bytes = serde_json::to_vec(data).map_err(|_| "acceptance_encoding_failed")?;
    if bytes.len() > 32768 {
        return Err("acceptance_size_exceeded".into());
    }
    write_private_file(&temporary, &bytes)?;
    let result = resource_config::atomic_replace(&temporary, &destination);
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opt_in_is_exact_and_failure_output_never_contains_raw_paths_or_credentials() {
        for value in [None, Some(""), Some("true"), Some("0"), Some("1; secrets")] {
            assert!(!enabled(value));
        }
        assert!(enabled(Some("1")));
        assert_eq!(
            public_failure("ram_budget_insufficient"),
            "ram_budget_insufficient"
        );
        assert_eq!(
            public_failure("C:/private/file Bearer SECRET"),
            "local_prepare_failed"
        );
        assert_eq!(
            public_failure("Local benchmark did not meet the signed capacity thresholds."),
            "local_benchmark_below_threshold"
        );
    }
    #[test]
    fn bounded_acceptance_writer_atomically_replaces_only_the_fixed_filename() {
        let root = std::env::temp_dir().join(format!("luczor-acceptance-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        write_report(&root, &json!({"success":false})).unwrap();
        write_report(&root, &json!({"success":true,"appPid":7})).unwrap();
        assert_eq!(
            serde_json::from_reader::<_, Value>(
                File::open(root.join("resource-acceptance.json")).unwrap()
            )
            .unwrap(),
            json!({"success":true,"appPid":7})
        );
        assert_eq!(
            write_report(&root, &json!("x".repeat(32769))).unwrap_err(),
            "acceptance_size_exceeded"
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_file(root.join("resource-acceptance.json")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
