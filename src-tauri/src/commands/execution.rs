//! Process-local execution admission shared by native desktop and workflow commands.
//! The gate starts closed and old renderer sessions can never reactivate it.
use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::sync::{Mutex, OnceLock};

use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};

use super::ensure_main_webview;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionMode {
    Observe,
    Act,
    Unrestricted,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionPermit {
    pub session_id: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_execution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ExecutionScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_generation: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionScope {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_binding_id: Option<String>,
}
impl ExecutionScope {
    fn key(&self) -> Result<String, String> {
        fn valid(value: &str) -> bool {
            !value.trim().is_empty() && value.len() <= 300 && !value.chars().any(char::is_control)
        }
        if !valid(&self.project_id) || [&self.conversation_id, &self.run_id, &self.workspace_binding_id]
            .into_iter().flatten().any(|value| !valid(value)) {
            return Err("execution_scope_invalid".into());
        }
        Ok(self.run_id.as_ref().map(|id| format!("run:{id}")).unwrap_or_else(||
            format!("project:{}:conversation:{}", self.project_id, self.conversation_id.as_deref().unwrap_or(""))))
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeRegistration {
    session_id: String,
    generation: u64,
    scope_generation: u64,
    scope: ExecutionScope,
}
struct RegisteredScope { scope: ExecutionScope, generation: u64, revoked: bool }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionPolicy {
    pub session_id: String,
    pub generation: u64,
    pub mode: ExecutionMode,
    pub kill_switch: bool,
}

#[derive(Default)]
struct GateState {
    policy: Option<ExecutionPolicy>,
    retired: HashSet<String>,
    cancelled_workflows: HashSet<String>,
    scopes: HashMap<String, RegisteredScope>,
}

impl GateState {
    fn update(&mut self, next: ExecutionPolicy) -> Result<ExecutionPolicy, String> {
        if uuid::Uuid::parse_str(&next.session_id)
            .map(|id| id.to_string() != next.session_id)
            .unwrap_or(true)
            || next.generation == 0
            || next.generation > 9_007_199_254_740_991
        {
            return Err("Invalid execution session or generation.".into());
        }
        if self.retired.contains(&next.session_id) {
            return Err("The execution session has been retired.".into());
        }
        if let Some(current) = &self.policy {
            if current.session_id == next.session_id {
                if next.generation == current.generation
                    && next.mode == current.mode
                    && next.kill_switch == current.kill_switch
                {
                    return Ok(current.clone());
                }
                if next.generation <= current.generation {
                    return Err("Stale execution generation.".into());
                }
            } else {
                self.retired.insert(current.session_id.clone());
            }
        }
        self.cancelled_workflows.clear();
        self.scopes.clear();
        self.policy = Some(next.clone());
        Ok(next)
    }

    fn check(
        &self,
        permit: &ExecutionPermit,
        write: bool,
        full_access: bool,
    ) -> Result<(), String> {
        let policy = self
            .policy
            .as_ref()
            .ok_or("Execution gate is not initialized.")?;
        if policy.session_id != permit.session_id || policy.generation != permit.generation {
            return Err("Execution scope changed; obtain a new reviewed request.".into());
        }
        if policy.kill_switch {
            return Err("Not-Aus is active; native execution is blocked.".into());
        }
        match (&permit.scope, permit.scope_generation) {
            (None, None) => {},
            (Some(scope), Some(generation)) => {
                let registered = self.scopes.get(&scope.key()?).ok_or("execution_scope_not_registered")?;
                if registered.revoked || registered.generation != generation || registered.scope != *scope {
                    return Err("execution_scope_revoked_or_changed".into());
                }
            },
            _ => return Err("execution_scope_invalid".into()),
        }
        if let Some(id) = &permit.workflow_execution_id {
            if uuid::Uuid::parse_str(id).is_err() || self.cancelled_workflows.contains(id) {
                return Err("Workflow execution was cancelled or is invalid.".into());
            }
        }
        if write && policy.mode == ExecutionMode::Observe {
            return Err("Native mutation is blocked in Observe mode.".into());
        }
        if full_access && policy.mode != ExecutionMode::Unrestricted {
            return Err(
                "Local scripts require explicit Unrestricted mode; this is not a sandbox.".into(),
            );
        }
        Ok(())
    }

    fn register_scope(&mut self, input: ScopeRegistration, revoke: bool) -> Result<(), String> {
        self.check(&ExecutionPermit {
            session_id: input.session_id, generation: input.generation,
            workflow_execution_id: None, scope: None, scope_generation: None,
        }, false, false)?;
        if input.scope_generation == 0 || input.scope_generation > 9_007_199_254_740_991 {
            return Err("execution_scope_invalid".into());
        }
        let key = input.scope.key()?;
        if let Some(previous) = self.scopes.get_mut(&key) {
            if previous.scope != input.scope || input.scope_generation < previous.generation {
                return Err("execution_scope_identity_changed".into());
            }
            if revoke {
                if previous.generation != input.scope_generation { return Err("execution_scope_generation_mismatch".into()); }
                previous.revoked = true;
            } else {
                if previous.revoked && input.scope_generation == previous.generation {
                    return Err("execution_scope_revoked_or_changed".into());
                }
                previous.generation = input.scope_generation;
                previous.revoked = false;
            }
        } else {
            if self.scopes.len() >= 8192 { return Err("execution_scope_capacity".into()); }
            self.scopes.insert(key, RegisteredScope {
                scope: input.scope, generation: input.scope_generation, revoked: revoke,
            });
        }
        Ok(())
    }
}

#[tauri::command]
pub fn execution_scope_register(window: crate::commands::CallerWebview, payload: ScopeRegistration) -> Result<(), String> {
    ensure_main_webview(&window)?;
    GATE.get_or_init(Mutex::default).lock().map_err(|_| "Execution gate unavailable.")?.register_scope(payload, false)
}
#[tauri::command]
pub fn execution_scope_revoke(window: crate::commands::CallerWebview, payload: ScopeRegistration) -> Result<(), String> {
    ensure_main_webview(&window)?;
    GATE.get_or_init(Mutex::default).lock().map_err(|_| "Execution gate unavailable.")?.register_scope(payload, true)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCancelPayload {
    execution_id: String,
}

#[tauri::command]
pub fn wf_execution_cancel(
    window: crate::commands::CallerWebview,
    payload: Guarded<WorkflowCancelPayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    uuid::Uuid::parse_str(&payload.request.execution_id)
        .map_err(|_| "Invalid workflow execution id.")?;
    let mut state = GATE
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Execution gate unavailable.")?;
    state.check(&payload.execution, false, false)?;
    if state.cancelled_workflows.len() >= 4096 {
        return Err("Workflow cancellation ledger is full; rotate the execution session.".into());
    }
    state
        .cancelled_workflows
        .insert(payload.request.execution_id);
    Ok(())
}

static GATE: OnceLock<Mutex<GateState>> = OnceLock::new();

#[derive(Clone)]
pub(crate) struct ExecutionLease {
    permit: ExecutionPermit,
    write: bool,
    full_access: bool,
}

impl ExecutionLease {
    pub fn check(&self) -> Result<(), String> {
        GATE.get_or_init(Mutex::default)
            .lock()
            .map_err(|_| "Execution gate unavailable.")?
            .check(&self.permit, self.write, self.full_access)
    }
}

pub(crate) fn admit(permit: &ExecutionPermit, write: bool) -> Result<ExecutionLease, String> {
    admit_full(permit, write, false)
}

pub(crate) fn admit_full(
    permit: &ExecutionPermit,
    write: bool,
    full_access: bool,
) -> Result<ExecutionLease, String> {
    let lease = ExecutionLease {
        permit: permit.clone(),
        write,
        full_access,
    };
    lease.check()?;
    Ok(lease)
}

pub struct Guarded<T> {
    pub execution: ExecutionPermit,
    pub request: T,
}
impl<'de, T: DeserializeOwned> Deserialize<'de> for Guarded<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut object = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        let execution = object
            .remove("execution")
            .ok_or_else(|| serde::de::Error::missing_field("execution"))?;
        // Deserialize the remaining object directly: serde(flatten) silently
        // drops unknown fields even when the inner request denies them.
        Ok(Self {
            execution: serde_json::from_value(execution).map_err(serde::de::Error::custom)?,
            request: serde_json::from_value(serde_json::Value::Object(object))
                .map_err(serde::de::Error::custom)?,
        })
    }
}
impl<T> Deref for Guarded<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.request
    }
}

#[derive(Deserialize)]
pub struct ExecutionOnly {
    pub execution: ExecutionPermit,
}

#[tauri::command]
pub async fn execution_gate_update(
    window: crate::commands::CallerWebview,
    payload: ExecutionPolicy,
) -> Result<ExecutionPolicy, String> {
    ensure_main_webview(&window)?;
    GATE.get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Execution gate unavailable.")?
        .update(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy(
        session: &str,
        generation: u64,
        mode: ExecutionMode,
        kill_switch: bool,
    ) -> ExecutionPolicy {
        ExecutionPolicy {
            session_id: session.into(),
            generation,
            mode,
            kill_switch,
        }
    }
    #[cfg(windows)]
    #[test]
    fn fresh_session_recovers_after_lost_initial_message_but_retries_cannot_change_policy() {
        let session = uuid::Uuid::new_v4().to_string();
        let mut gate = GateState::default();
        gate.update(policy(&session, 4, ExecutionMode::Observe, true))
            .unwrap();
        assert!(gate
            .update(policy(&session, 4, ExecutionMode::Observe, true))
            .is_ok());
        assert!(gate
            .update(policy(&session, 4, ExecutionMode::Act, false))
            .is_err());
        assert!(gate
            .update(policy(&session, 1, ExecutionMode::Act, false))
            .is_err());
    }

    #[test]
    fn revoking_generation_stops_a_running_native_process() {
        let session = uuid::Uuid::new_v4().to_string();
        GATE.get_or_init(Mutex::default)
            .lock()
            .unwrap()
            .update(policy(&session, 1, ExecutionMode::Act, false))
            .unwrap();
        let permit = ExecutionPermit {
            session_id: session.clone(),
            generation: 1,
            workflow_execution_id: None,
        scope: None, scope_generation: None,
        };
        let lease = admit(&permit, true).unwrap();
        let worker = std::thread::spawn(move || {
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/D", "/S", "/C", "ping 127.0.0.1 -n 20 >NUL"]);
            super::super::process::run_bounded_command_guarded(
                command,
                None,
                std::time::Duration::from_secs(5),
                64,
                Some(lease),
            )
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        let stopped = std::time::Instant::now();
        GATE.get_or_init(Mutex::default)
            .lock()
            .unwrap()
            .update(policy(&session, 2, ExecutionMode::Observe, true))
            .unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(stopped.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn closed_gate_and_revoked_generation_cannot_execute() {
        let session = uuid::Uuid::new_v4().to_string();
        let permit = ExecutionPermit {
            session_id: session.clone(),
            generation: 1,
            workflow_execution_id: None,
        scope: None, scope_generation: None,
        };
        let mut gate = GateState::default();
        assert!(gate.check(&permit, false, false).is_err());
        gate.update(policy(&session, 1, ExecutionMode::Act, false))
            .unwrap();
        assert!(gate.check(&permit, true, false).is_ok());
        gate.update(policy(&session, 2, ExecutionMode::Observe, false))
            .unwrap();
        assert!(gate.check(&permit, false, false).is_err());
        let current = ExecutionPermit {
            generation: 2,
            ..permit
        };
        assert!(gate.check(&current, false, false).is_ok());
        assert!(gate.check(&current, true, false).is_err());
    }
    #[test]
    fn replaced_session_and_old_updates_cannot_reactivate_policy() {
        let first = uuid::Uuid::new_v4().to_string();
        let next = uuid::Uuid::new_v4().to_string();
        let mut gate = GateState::default();
        gate.update(policy(&first, 1, ExecutionMode::Act, false))
            .unwrap();
        gate.update(policy(&next, 1, ExecutionMode::Unrestricted, true))
            .unwrap();
        assert!(gate
            .update(policy(&first, 2, ExecutionMode::Unrestricted, false))
            .is_err());
        assert!(gate
            .update(policy(&next, 1, ExecutionMode::Act, false))
            .is_err());
        assert!(gate
            .check(
                &ExecutionPermit {
                    session_id: next,
                    generation: 1,
                    workflow_execution_id: None,
                scope: None, scope_generation: None,
                },
                false,
                false
            )
            .is_err());
    }
    #[test]
    fn scripts_require_unrestricted_but_kill_switch_always_wins() {
        let session = uuid::Uuid::new_v4().to_string();
        let mut gate = GateState::default();
        gate.update(policy(&session, 1, ExecutionMode::Act, false))
            .unwrap();
        let permit = ExecutionPermit {
            session_id: session.clone(),
            generation: 1,
            workflow_execution_id: None,
        scope: None, scope_generation: None,
        };
        assert!(gate.check(&permit, true, true).is_err());
        gate.update(policy(&session, 2, ExecutionMode::Unrestricted, false))
            .unwrap();
        assert!(gate
            .check(
                &ExecutionPermit {
                    generation: 2,
                    ..permit
                },
                true,
                true
            )
            .is_ok());
    }

    #[test]
    fn workflow_cancellation_stops_only_the_targeted_execution() {
        let session = uuid::Uuid::new_v4().to_string();
        let cancelled = uuid::Uuid::new_v4().to_string();
        let mut gate = GateState::default();
        gate.update(policy(&session, 1, ExecutionMode::Act, false))
            .unwrap();
        gate.cancelled_workflows.insert(cancelled.clone());
        let permit = ExecutionPermit {
            session_id: session,
            generation: 1,
            workflow_execution_id: Some(cancelled),
            scope: None, scope_generation: None,
        };
        assert!(gate.check(&permit, true, false).is_err());
        let other = ExecutionPermit {
            workflow_execution_id: Some(uuid::Uuid::new_v4().to_string()),
            ..permit
        };
        assert!(gate.check(&other, true, false).is_ok());
    }
}
