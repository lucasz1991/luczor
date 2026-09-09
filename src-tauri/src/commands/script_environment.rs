//! Reproducible project-local packages for the reviewed Windows host-user script profile.
//! No interpreter download, global install, shell command composition, or relaxed execution lease.
use super::{
    execution::ExecutionLease,
    local_tasks::{is_link_like, safe_path},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    time::Instant,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptDependency {
    pub name: String,
    pub version: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptEnvironment {
    pub version: u32,
    pub runtime_version: String,
    pub dependencies: Vec<ScriptDependency>,
    pub lock_path: Option<String>,
    pub lock_sha256: Option<String>,
}
#[derive(Serialize)]
pub struct EnvironmentReport {
    pub revision: String,
    pub lock_sha256: Option<String>,
    pub dependency_count: usize,
    pub reused: bool,
    pub installed_sha256: String,
}
pub struct PreparedEnvironment {
    pub interpreter: PathBuf,
    pub directory: PathBuf,
    pub report: EnvironmentReport,
}
fn matches(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern).is_ok_and(|r| r.is_match(value))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn normalized_name(runtime: &str, name: &str) -> String {
    if runtime == "python" {
        name.to_ascii_lowercase()
            .replace(['_', '.'], "-")
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-")
    } else {
        name.into()
    }
}
impl ScriptEnvironment {
    pub fn validate(&self, runtime: &str) -> Result<(), String> {
        if self.version != 1
            || !matches(r"^\d+\.\d+\.\d+$", &self.runtime_version)
            || self.dependencies.len() > 64
        {
            return Err("workflow_script_environment_invalid".into());
        }
        let mut names = std::collections::HashSet::new();
        for dep in &self.dependencies {
            let name_pattern = if runtime == "node" {
                r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$"
            } else {
                r"^[A-Za-z0-9][A-Za-z0-9._-]*$"
            };
            if dep.name.len() > 160
                || !matches(name_pattern, &dep.name)
                || dep.version.len() > 60
                || !matches(
                    r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][A-Za-z0-9.-]+)?$",
                    &dep.version,
                )
            {
                return Err("workflow_script_dependency_invalid".into());
            }
            if !names.insert(normalized_name(runtime, &dep.name)) {
                return Err("workflow_script_dependency_duplicate".into());
            }
        }
        if !self.dependencies.is_empty() || self.lock_path.is_some() || self.lock_sha256.is_some() {
            let path = self
                .lock_path
                .as_deref()
                .ok_or("workflow_script_lock_invalid")?;
            if path.is_empty()
                || path.len() > 500
                || path.split(['/', '\\']).any(|p| {
                    p.is_empty()
                        || p == "."
                        || p == ".."
                        || p.chars().any(|c| c == ':' || c.is_control())
                })
                || !self
                    .lock_sha256
                    .as_deref()
                    .is_some_and(|s| matches(r"^[a-f0-9]{64}$", s))
            {
                return Err("workflow_script_lock_invalid".into());
            }
        }
        Ok(())
    }
    fn dependencies_map(&self, runtime: &str) -> BTreeMap<String, String> {
        self.dependencies
            .iter()
            .map(|d| (normalized_name(runtime, &d.name), d.version.clone()))
            .collect()
    }
}
fn bounded_file(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "workflow_environment_file_missing")?;
    if is_link_like(&meta) || !meta.is_file() || meta.len() > max as u64 {
        return Err("workflow_environment_file_invalid".into());
    }
    let mut data = Vec::new();
    fs::File::open(path)
        .map_err(|_| "workflow_environment_file_unreadable")?
        .take(max as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|_| "workflow_environment_file_unreadable")?;
    if data.len() > max {
        return Err("workflow_environment_file_too_large".into());
    }
    Ok(data)
}
fn exact_file(root: &Path, relative: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    use std::io::Write;
    let path = safe_path(root, relative, true)?;
    if path.exists() {
        if bounded_file(&path, 2_000_000)? != bytes {
            return Err("workflow_environment_file_changed".into());
        }
    } else {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "workflow_environment_file_create_failed")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "workflow_environment_file_write_failed")?;
    }
    Ok(path)
}
/// The lock is part of the approved workflow via its immutable hash; registry URLs cannot be supplied as shell flags.
fn validate_lock(config: &ScriptEnvironment, runtime: &str, bytes: &[u8]) -> Result<(), String> {
    if runtime == "node" {
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| "workflow_npm_lock_invalid")?;
        if value["lockfileVersion"] != 3 {
            return Err("workflow_npm_lock_version_unsupported".into());
        }
        let packages = value["packages"]
            .as_object()
            .ok_or("workflow_npm_lock_invalid")?;
        if packages.len() > 500 || packages.is_empty() {
            return Err("workflow_npm_lock_invalid".into());
        }
        let root_package = packages.get("").ok_or("workflow_npm_lock_root_missing")?;
        let declared: BTreeMap<String, String> =
            serde_json::from_value(root_package["dependencies"].clone())
                .map_err(|_| "workflow_npm_lock_dependencies_invalid")?;
        if declared != config.dependencies_map(runtime) {
            return Err("workflow_lock_dependencies_mismatch".into());
        }
        for (path, package) in packages {
            if path.is_empty() {
                continue;
            }
            if !path.starts_with("node_modules/")
                || path
                    .split('/')
                    .any(|s| s.is_empty() || s == "." || s == "..")
                || path.contains(['\\', ':'])
                || package["link"] == true
            {
                return Err("workflow_npm_lock_path_invalid".into());
            }
            let resolved = package["resolved"]
                .as_str()
                .ok_or("workflow_npm_lock_source_missing")?;
            let url =
                reqwest::Url::parse(resolved).map_err(|_| "workflow_npm_lock_source_invalid")?;
            if url.scheme() != "https"
                || url.host_str() != Some("registry.npmjs.org")
                || !url.username().is_empty()
                || url.password().is_some()
                || url.port().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("workflow_npm_lock_source_invalid".into());
            }
            if !package["integrity"]
                .as_str()
                .is_some_and(|s| matches(r"^sha(256|512)-[A-Za-z0-9+/]+={0,2}$", s))
            {
                return Err("workflow_npm_lock_integrity_required".into());
            }
        }
        for dep in &config.dependencies {
            if value["packages"][format!("node_modules/{}", dep.name)]["version"] != dep.version {
                return Err("workflow_lock_dependencies_mismatch".into());
            }
        }
    } else {
        let text = std::str::from_utf8(bytes).map_err(|_| "workflow_python_lock_invalid")?;
        let mut declared = BTreeMap::new();
        for line in text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
        {
            let mut fields = line.split_whitespace();
            let (name, version) = fields
                .next()
                .and_then(|s| s.split_once("=="))
                .ok_or("workflow_python_lock_invalid")?;
            let hashes: Vec<_> = fields.collect();
            if !matches(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", name)
                || hashes.is_empty()
                || hashes.len() > 64
                || !hashes
                    .iter()
                    .all(|h| matches(r"^--hash=sha256:[a-f0-9]{64}$", h))
            {
                return Err("workflow_python_lock_hash_required".into());
            }
            if declared
                .insert(normalized_name(runtime, name), version.to_string())
                .is_some()
            {
                return Err("workflow_script_dependency_duplicate".into());
            }
        }
        // Include transitives in the explicit fully pinned requirements, as required by pip --require-hashes.
        if declared != config.dependencies_map(runtime) {
            return Err("workflow_lock_dependencies_mismatch".into());
        }
    }
    Ok(())
}
fn clean_command(exe: &Path, directory: &Path) -> Command {
    let mut cmd = Command::new(exe);
    cmd.current_dir(directory);
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if name.starts_with("NPM_CONFIG_")
            || name.starts_with("PIP_")
            || name.starts_with("PYTHON")
            || ["NODE_OPTIONS", "NODE_PATH", "VIRTUAL_ENV"].contains(&name.as_str())
        {
            cmd.env_remove(key);
        }
    }
    cmd.env("PYTHONNOUSERSITE", "1");
    cmd.env("PYTHONDONTWRITEBYTECODE", "1");
    #[cfg(windows)]
    // pip compares this value to Python's os.devnull with a case-sensitive string comparison.
    cmd.env("PIP_CONFIG_FILE", "nul");
    #[cfg(not(windows))]
    cmd.env("PIP_CONFIG_FILE", "/dev/null");
    cmd
}
fn run(
    mut command: Command,
    stdin: Option<Vec<u8>>,
    deadline: Instant,
    lease: Option<ExecutionLease>,
    check: &dyn Fn() -> Result<(), String>,
    failure_code: &'static str,
) -> Result<String, String> {
    check()?;
    let timeout = deadline
        .checked_duration_since(Instant::now())
        .filter(|v| !v.is_zero())
        .ok_or("workflow_environment_timeout")?;
    command.env("PYTHONNOUSERSITE", "1");
    let out = super::process::run_bounded_command_scoped(
        command,
        stdin,
        timeout,
        20_000,
        lease,
        Some(check),
    )?;
    check()?;
    if out.timed_out {
        return Err("workflow_environment_timeout".into());
    }
    // Package-manager output may contain local paths/configuration; public errors use bounded diagnostic codes.
    if !out.success || out.stdout_truncated || out.stderr_truncated {
        return Err(failure_code.into());
    }
    Ok(out.stdout)
}

fn installed_hash(
    directory: &Path,
    subtree: &str,
    deadline: Instant,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<String, String> {
    let root = safe_path(directory, subtree, false)?;
    let mut pending = vec![root];
    let mut hasher = Sha256::new();
    let mut files = 0usize;
    let mut total = 0u64;
    while let Some(path) = pending.pop() {
        check()?;
        if Instant::now() >= deadline {
            return Err("workflow_environment_timeout".into());
        }
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && path == directory.join(subtree) =>
            {
                continue
            }
            Err(_) => return Err("workflow_environment_integrity_unavailable".into()),
        };
        if is_link_like(&meta) {
            return Err("workflow_environment_link_detected".into());
        }
        let relative = path
            .strip_prefix(directory)
            .map_err(|_| "workflow_environment_scope_changed")?
            .to_string_lossy();
        hasher.update((relative.len() as u64).to_le_bytes());
        hasher.update(relative.as_bytes());
        if meta.is_dir() {
            hasher.update(b"directory");
            let mut entries = fs::read_dir(&path)
                .map_err(|_| "workflow_environment_integrity_unavailable")?
                .map(|entry| entry.map(|e| e.path()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "workflow_environment_integrity_unavailable")?;
            entries.sort();
            pending.extend(entries);
            if pending.len() > 100_000 {
                return Err("workflow_environment_integrity_limit".into());
            }
        } else if meta.is_file() {
            files += 1;
            total = total.saturating_add(meta.len());
            if files > 100_000 || total > 1_073_741_824 {
                return Err("workflow_environment_integrity_limit".into());
            }
            hasher.update(b"file");
            hasher.update(meta.len().to_le_bytes());
            let mut file =
                fs::File::open(&path).map_err(|_| "workflow_environment_integrity_unavailable")?;
            let mut buffer = [0u8; 64 * 1024];
            let mut read = 0u64;
            loop {
                check()?;
                if Instant::now() >= deadline {
                    return Err("workflow_environment_timeout".into());
                }
                let size = file
                    .read(&mut buffer)
                    .map_err(|_| "workflow_environment_integrity_unavailable")?;
                if size == 0 {
                    break;
                }
                read += size as u64;
                if read > meta.len() {
                    return Err("workflow_environment_integrity_changed".into());
                }
                hasher.update(&buffer[..size]);
            }
            if read != meta.len() {
                return Err("workflow_environment_integrity_changed".into());
            }
        } else {
            return Err("workflow_environment_file_invalid".into());
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}
fn commit_receipt(directory: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let target = safe_path(directory, "receipt.json", false)?;
    let temporary = safe_path(
        directory,
        &format!("receipt-{}.tmp", uuid::Uuid::new_v4()),
        false,
    )?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "workflow_environment_receipt_create_failed")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "workflow_environment_receipt_write_failed")?;
    drop(file);
    if target.exists() {
        return Err("workflow_environment_receipt_changed".into());
    }
    fs::rename(temporary, target).map_err(|_| "workflow_environment_receipt_commit_failed".into())
}

#[allow(clippy::too_many_arguments)]
pub fn prepare(
    config: &ScriptEnvironment,
    runtime: &str,
    exe: &Path,
    observed_version: &str,
    project: &Path,
    deadline: Instant,
    lease: Option<ExecutionLease>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<PreparedEnvironment, String> {
    config.validate(runtime)?;
    let actual = observed_version
        .trim_start_matches('v')
        .trim_start_matches("Python ");
    if actual != config.runtime_version {
        return Err("workflow_script_runtime_version_mismatch".into());
    }
    check()?;
    let root = project
        .canonicalize()
        .map_err(|_| "workflow_environment_project_unavailable")?;
    let bytes = config
        .lock_path
        .as_deref()
        .map(|path| bounded_file(&safe_path(&root, path, false)?, 2_000_000))
        .transpose()?;
    if let Some(bytes) = &bytes {
        if Some(digest(bytes)) != config.lock_sha256 {
            return Err("workflow_script_lock_hash_mismatch".into());
        }
        validate_lock(config, runtime, bytes)?;
    }
    let revision = digest(
        serde_json::to_vec(&json!({"runtime":runtime,"config":config}))
            .map_err(|_| "workflow_environment_hash_failed")?
            .as_slice(),
    );
    let marker = safe_path(
        &root,
        &format!(".luczor/workflow-environments/{revision}/receipt.json"),
        true,
    )?;
    let directory = marker
        .parent()
        .ok_or("workflow_environment_directory_invalid")?
        .to_path_buf();
    let guarded = || {
        check()?;
        if safe_path(
            &root,
            &format!(".luczor/workflow-environments/{revision}/receipt.json"),
            false,
        )? != marker
        {
            return Err("workflow_environment_scope_changed".into());
        }
        Ok(())
    };
    guarded()?;
    let receipt_contract = json!({"version":1,"revision":revision,"runtime":runtime,"runtime_version":actual,"lock_sha256":config.lock_sha256});
    let reused = marker.exists();
    let installed_root = if runtime == "node" {
        "node_modules"
    } else {
        "venv"
    };
    let installed_before = installed_hash(&directory, installed_root, deadline, &guarded)?;
    if reused {
        let receipt: Value = serde_json::from_slice(&bounded_file(&marker, 4_000)?)
            .map_err(|_| "workflow_environment_receipt_changed")?;
        if receipt["contract"] != receipt_contract
            || receipt["installed_sha256"] != installed_before
        {
            return Err("workflow_environment_integrity_changed".into());
        }
    }
    let mut interpreter = exe.to_path_buf();
    if !config.dependencies.is_empty() {
        let lock = bytes.as_deref().ok_or("workflow_script_lock_invalid")?;
        if runtime == "node" {
            exact_file(&directory, ".npmrc", b"")?;
            // npm ci removes only this managed node_modules tree; never hand it an injected link.
            safe_path(&directory, "node_modules", false)?;
            exact_file(&directory, "package-lock.json", lock)?;
            let package = serde_json::to_vec(&json!({"name":"luczor-workflow-environment","version":"1.0.0","private":true,"dependencies":config.dependencies_map(runtime)})).map_err(|_| "workflow_environment_package_invalid")?;
            exact_file(&directory, "package.json", &package)?;
            if !reused {
                let npm = exe
                    .parent()
                    .ok_or("workflow_npm_runtime_unavailable")?
                    .join("node_modules/npm/bin/npm-cli.js");
                if !npm.is_file() {
                    return Err("workflow_npm_runtime_unavailable".into());
                }
                let user_config = exact_file(&directory, "user.npmrc", b"")?;
                let global_config = exact_file(&directory, "global.npmrc", b"")?;
                let mut cmd = clean_command(exe, &directory);
                cmd.arg(npm)
                    .args([
                        "ci",
                        "--ignore-scripts",
                        "--no-audit",
                        "--no-fund",
                        "--no-bin-links",
                        "--workspaces=false",
                        "--registry=https://registry.npmjs.org",
                        "--loglevel=error",
                        "--fetch-retries=0",
                    ])
                    .arg(format!("--userconfig={}", user_config.display()))
                    .arg(format!("--globalconfig={}", global_config.display()))
                    .arg(format!("--cache={}", directory.join("cache").display()));
                run(
                    cmd,
                    None,
                    deadline,
                    lease.clone(),
                    &guarded,
                    "workflow_npm_install_failed",
                )?;
            }
            for dep in &config.dependencies {
                let file = safe_path(
                    &directory,
                    &format!("node_modules/{}/package.json", dep.name),
                    false,
                )?;
                let package: Value = serde_json::from_slice(&bounded_file(&file, 1_000_000)?)
                    .map_err(|_| "workflow_environment_package_invalid")?;
                if package["version"] != dep.version {
                    return Err("workflow_environment_package_version_mismatch".into());
                }
            }
        } else {
            let requirements = exact_file(&directory, "requirements.lock", lock)?;
            #[cfg(windows)]
            let python_relative = "venv/Scripts/python.exe";
            #[cfg(not(windows))]
            let python_relative = "venv/bin/python";
            if !reused {
                let mut cmd = clean_command(exe, &directory);
                // Use the checked working directory so Python's nested ensurepip command
                // receives a regular absolute path, not Rust's Windows verbatim prefix.
                cmd.args(["-I", "-m", "venv", "--copies", "venv"]);
                run(
                    cmd,
                    None,
                    deadline,
                    lease.clone(),
                    &guarded,
                    "workflow_python_venv_failed",
                )?;
            }
            interpreter = safe_path(&directory, python_relative, false)?;
            if !interpreter.is_file() {
                return Err("workflow_environment_python_unavailable".into());
            }
            if !reused {
                let mut cmd = clean_command(&interpreter, &directory);
                cmd.args([
                    "-I",
                    "-m",
                    "pip",
                    "--isolated",
                    "--disable-pip-version-check",
                    "install",
                    "--require-hashes",
                    "--only-binary=:all:",
                    "--no-deps",
                    "--no-compile",
                    "--no-input",
                    "--no-cache-dir",
                    "--index-url",
                    "https://pypi.org/simple",
                    "-r",
                ])
                .arg(requirements);
                run(
                    cmd,
                    None,
                    deadline,
                    lease.clone(),
                    &guarded,
                    "workflow_pip_install_failed",
                )?;
            }
            let mut check_packages = clean_command(&interpreter, &directory);
            check_packages.args([
                "-I",
                "-m",
                "pip",
                "--isolated",
                "--disable-pip-version-check",
                "check",
            ]);
            run(
                check_packages,
                None,
                deadline,
                lease.clone(),
                &guarded,
                "workflow_pip_check_failed",
            )?;
            let mut cmd = clean_command(&interpreter, &directory);
            cmd.args(["-I", "-c", "import importlib.metadata,json,sys; expected=json.load(sys.stdin); json.dump({name:importlib.metadata.version(name) for name in expected},sys.stdout)"]);
            let expected = config.dependencies_map(runtime);
            let output = run(
                cmd,
                Some(
                    serde_json::to_vec(&expected)
                        .map_err(|_| "workflow_environment_package_invalid")?,
                ),
                deadline,
                lease.clone(),
                &guarded,
                "workflow_python_metadata_failed",
            )?;
            let actual: BTreeMap<String, String> = serde_json::from_str(&output)
                .map_err(|_| "workflow_environment_package_invalid")?;
            if actual != expected {
                return Err("workflow_environment_package_version_mismatch".into());
            }
        }
    }
    guarded()?;
    // A setup command must not replace its frozen lock or receipt before being accepted.
    if let Some(lock) = &bytes {
        exact_file(
            &directory,
            if runtime == "node" {
                "package-lock.json"
            } else {
                "requirements.lock"
            },
            lock,
        )?;
    }
    let installed_sha256 = installed_hash(&directory, installed_root, deadline, &guarded)?;
    if reused && installed_sha256 != installed_before {
        return Err("workflow_environment_integrity_changed".into());
    }
    if !reused {
        commit_receipt(
            &directory,
            &serde_json::to_vec(
                &json!({"contract":receipt_contract,"installed_sha256":installed_sha256}),
            )
            .map_err(|_| "workflow_environment_receipt_invalid")?,
        )?;
    }
    Ok(PreparedEnvironment {
        interpreter,
        directory,
        report: EnvironmentReport {
            revision,
            lock_sha256: config.lock_sha256.clone(),
            dependency_count: config.dependencies.len(),
            reused,
            installed_sha256,
        },
    })
}
impl PreparedEnvironment {
    pub fn apply(&self, command: &mut Command, _runtime: &str) {
        command
            .env_remove("PYTHONPATH")
            .env_remove("PYTHONHOME")
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1");
    }
    pub fn node_script(&self, code: &str) -> Result<PathBuf, String> {
        exact_file(
            &self.directory,
            &format!("script-{}.cjs", digest(code.as_bytes())),
            code.as_bytes(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_commands_disable_all_pip_configuration() {
        let command = clean_command(Path::new("python"), Path::new("."));
        let config = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PIP_CONFIG_FILE"))
            .and_then(|(_, value)| value)
            .unwrap();
        // Exact spelling matters: pip compares with os.devnull before opening a file.
        #[cfg(windows)]
        assert_eq!(config, "nul");
        #[cfg(not(windows))]
        assert_eq!(config, "/dev/null");
    }
    fn config() -> ScriptEnvironment {
        ScriptEnvironment {
            version: 1,
            runtime_version: "22.22.0".into(),
            dependencies: vec![],
            lock_path: None,
            lock_sha256: None,
        }
    }
    #[test]
    fn versions_names_and_lock_paths_are_closed() {
        let mut c = config();
        assert!(c.validate("node").is_ok());
        c.dependencies.push(ScriptDependency {
            name: "package".into(),
            version: "1.0.0".into(),
        });
        assert!(c.validate("node").is_err());
        c.lock_path = Some("locks/npm.json".into());
        c.lock_sha256 = Some("a".repeat(64));
        assert!(c.validate("node").is_ok());
        for path in [
            "../escape",
            "C:/tmp/lock",
            "\\\\host\\file",
            "/absolute",
            "x/./a",
        ] {
            c.lock_path = Some(path.into());
            assert!(c.validate("node").is_err());
        }
        c.lock_path = Some("lock.json".into());
        for version in ["latest", "^1.0.0", "1.*", "1.0.0 --shell", "https://bad"] {
            c.dependencies[0].version = version.into();
            assert!(c.validate("node").is_err());
        }
    }
    #[test]
    fn python_lock_requires_all_exact_dependencies_and_hashes() {
        let mut c = config();
        c.dependencies = vec![ScriptDependency {
            name: "demo".into(),
            version: "1.0.0".into(),
        }];
        assert!(validate_lock(
            &c,
            "python",
            format!("demo==1.0.0 --hash=sha256:{}", "a".repeat(64)).as_bytes()
        )
        .is_ok());
        for lock in [
            "demo==1.0.0",
            "--index-url https://other",
            "demo @ https://other/file",
            "demo==2.0.0 --hash=sha256:a",
        ] {
            assert!(validate_lock(&c, "python", lock.as_bytes()).is_err());
        }
    }
    #[test]
    fn npm_lock_never_accepts_local_or_unhashed_sources() {
        let mut c = config();
        c.dependencies = vec![ScriptDependency {
            name: "demo".into(),
            version: "1.0.0".into(),
        }];
        let mut lock = json!({"lockfileVersion":3,"packages":{"":{"dependencies":{"demo":"1.0.0"}},"node_modules/demo":{"version":"1.0.0","resolved":"https://registry.npmjs.org/demo/-/demo-1.0.0.tgz","integrity":"sha512-YWJjZA=="}}});
        assert!(validate_lock(&c, "node", &serde_json::to_vec(&lock).unwrap()).is_ok());
        let mut missing_root = lock.clone();
        missing_root["packages"].as_object_mut().unwrap().remove("");
        assert!(validate_lock(&c, "node", &serde_json::to_vec(&missing_root).unwrap()).is_err());
        for source in [
            "file:../package",
            "https://user:pass@registry.npmjs.org/a",
            "https://other.test/a",
        ] {
            lock["packages"]["node_modules/demo"]["resolved"] = json!(source);
            assert!(validate_lock(&c, "node", &serde_json::to_vec(&lock).unwrap()).is_err());
        }
    }
    #[test]
    fn empty_environment_reuses_exact_receipt_and_refuses_changed_runtime() {
        let root = std::env::temp_dir().join(format!("luczor-env-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let c = config();
        let run = || {
            prepare(
                &c,
                "node",
                Path::new("node.exe"),
                "v22.22.0",
                &root,
                Instant::now() + std::time::Duration::from_secs(5),
                None,
                &|| Ok(()),
            )
        };
        let first = run().unwrap();
        assert!(!first.report.reused);
        assert!(run().unwrap().report.reused);
        assert!(prepare(
            &c,
            "node",
            Path::new("node.exe"),
            "v22.23.0",
            &root,
            Instant::now(),
            None,
            &|| Ok(())
        )
        .is_err());
        fs::write(first.directory.join("receipt.json"), b"changed").unwrap();
        assert!(run().is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn reuse_detects_package_content_changes_even_when_versions_are_unchanged() {
        let root =
            std::env::temp_dir().join(format!("luczor-env-content-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let c = config();
        let run = || {
            prepare(
                &c,
                "node",
                Path::new("node.exe"),
                "v22.22.0",
                &root,
                Instant::now() + std::time::Duration::from_secs(5),
                None,
                &|| Ok(()),
            )
        };
        let first = run().unwrap();
        fs::create_dir_all(first.directory.join("node_modules/demo")).unwrap();
        fs::write(
            first.directory.join("node_modules/demo/index.js"),
            b"changed",
        )
        .unwrap();
        assert_eq!(
            run().err().unwrap(),
            "workflow_environment_integrity_changed"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn checks_do_not_create_ready_receipts_on_cancel_or_expired_deadline() {
        let root = std::env::temp_dir().join(format!("luczor-env-cancel-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        assert!(prepare(
            &config(),
            "node",
            Path::new("node.exe"),
            "v22.22.0",
            &root,
            Instant::now(),
            None,
            &|| Ok(())
        )
        .is_err());
        assert!(prepare(
            &config(),
            "node",
            Path::new("node.exe"),
            "v22.22.0",
            &root,
            Instant::now(),
            None,
            &|| Err("revoked".into())
        )
        .is_err());
        let mut receipts = vec![root.clone()];
        while let Some(path) = receipts.pop() {
            for entry in fs::read_dir(path).unwrap() {
                let path = entry.unwrap().path();
                assert_ne!(path.file_name().unwrap(), "receipt.json");
                if path.is_dir() {
                    receipts.push(path);
                }
            }
        }
        fs::remove_dir_all(root).unwrap();
    }
}
