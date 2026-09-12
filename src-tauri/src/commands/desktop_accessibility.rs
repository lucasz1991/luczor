//! Linux accessibility actions target an observed application object, never renderer DBus paths.
use super::execution::{ExecutionOnly, Guarded};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "linux")]
#[path = "desktop_portal.rs"]
pub(super) mod portal;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observe {
    application_pid: Option<u32>,
    max_nodes: Option<usize>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    observation_id: String,
    node_id: String,
    action: ActionKind,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    action_index: Option<usize>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ActionKind {
    Invoke,
    SetText,
    Focus,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    id: String,
    application_pid: u32,
    name: String,
    role: String,
    actions: Vec<String>,
    editable: bool,
    focused: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    observation_id: String,
    nodes: Vec<Node>,
    expires_in_ms: u64,
    truncated: bool,
    backend: &'static str,
}

#[tauri::command]
pub async fn desktop_accessibility_observe(
    window: super::CallerWebview,
    payload: Guarded<Observe>,
) -> Result<Snapshot, String> {
    super::ensure_main_webview(&window)?;
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || linux::observe(payload))
            .await
            .map_err(|_| "desktop_accessibility_worker_failed")?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = payload;
        Err("desktop_accessibility_adapter_not_available".into())
    }
}
#[tauri::command]
pub async fn desktop_accessibility_action(
    window: super::CallerWebview,
    payload: Guarded<Action>,
) -> Result<bool, String> {
    super::ensure_main_webview(&window)?;
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || linux::action(payload))
            .await
            .map_err(|_| "desktop_accessibility_worker_failed")?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = payload;
        Err("desktop_accessibility_adapter_not_available".into())
    }
}
#[tauri::command]
pub async fn desktop_adapter_status(
    window: super::CallerWebview,
) -> Result<serde_json::Value, String> {
    super::ensure_main_webview(&window)?;
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(linux::status)
            .await
            .map_err(|_| "desktop_accessibility_worker_failed")?
    }
    #[cfg(windows)]
    {
        Ok(
            serde_json::json!({"backend":"win32","windowInput":true,"semanticInput":false,"portal":"not_required"}),
        )
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Ok(serde_json::json!({"backend":"unsupported","windowInput":false,"semanticInput":false}))
    }
}
#[tauri::command]
pub async fn desktop_portal_setup(
    window: super::CallerWebview,
    payload: ExecutionOnly,
) -> Result<serde_json::Value, String> {
    super::ensure_main_webview(&window)?;
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || portal::setup(payload.execution))
            .await
            .map_err(|_| "desktop_portal_worker_failed")?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = payload;
        Err("desktop_portal_not_required".into())
    }
}
#[tauri::command]
pub fn desktop_portal_close(window: super::CallerWebview) -> Result<(), String> {
    super::ensure_main_webview(&window)?;
    #[cfg(target_os = "linux")]
    {
        portal::close()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
pub(super) mod linux {
    use super::*;
    use crate::commands::execution::{admit, ExecutionPermit};
    use std::{
        collections::{BTreeMap, HashSet, VecDeque},
        sync::{Mutex, OnceLock},
        time::{Duration, Instant},
    };
    use zbus::{
        blocking::{Connection, Proxy},
        zvariant::OwnedObjectPath,
    };
    type Object = (String, OwnedObjectPath);
    struct ObservedNode {
        public: Node,
        object: Object,
        process_started: u64,
        interfaces: Vec<String>,
        enabled: bool,
    }
    struct Observation {
        execution: ExecutionPermit,
        created: Instant,
        nodes: BTreeMap<String, ObservedNode>,
    }
    static OBSERVATIONS: OnceLock<Mutex<BTreeMap<String, Observation>>> = OnceLock::new();
    pub(super) fn session() -> Result<Connection, String> {
        zbus::blocking::connection::Builder::session()
            .map_err(|_| "desktop_session_bus_unavailable")?
            .method_timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| "desktop_session_bus_unavailable".into())
    }
    fn bus() -> Result<Connection, String> {
        let session = session()?;
        let proxy = Proxy::new(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus")
            .map_err(|_| "desktop_accessibility_unavailable")?;
        let address: String = proxy
            .call("GetAddress", &())
            .map_err(|_| "desktop_accessibility_unavailable")?;
        zbus::blocking::connection::Builder::address(address.as_str())
            .map_err(|_| "desktop_accessibility_unavailable")?
            .method_timeout(Duration::from_secs(1))
            .build()
            .map_err(|_| "desktop_accessibility_unavailable".into())
    }
    fn proxy<'a>(
        bus: &'a Connection,
        object: &'a Object,
        interface: &'a str,
    ) -> Result<Proxy<'a>, String> {
        Proxy::new(bus, object.0.as_str(), object.1.as_str(), interface)
            .map_err(|_| "desktop_accessibility_object_unavailable".into())
    }
    fn process(bus: &Connection, name: &str) -> Result<(u32, u64), String> {
        let proxy = Proxy::new(
            bus,
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
        )
        .map_err(|_| "desktop_accessibility_process_unavailable")?;
        let pid: u32 = proxy
            .call("GetConnectionUnixProcessID", &(name,))
            .map_err(|_| "desktop_accessibility_process_unavailable")?;
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map_err(|_| "desktop_accessibility_process_unavailable")?;
        let start = stat
            .rsplit_once(") ")
            .ok_or("desktop_accessibility_process_invalid")?
            .1
            .split_whitespace()
            .nth(19)
            .ok_or("desktop_accessibility_process_invalid")?
            .parse::<u64>()
            .map_err(|_| "desktop_accessibility_process_invalid")?;
        Ok((pid, start))
    }
    fn has_state(states: &[u32], bit: usize) -> bool {
        states
            .get(bit / 32)
            .is_some_and(|mask| mask & (1_u32 << (bit % 32)) != 0)
    }
    fn inspect(bus: &Connection, object: Object) -> Result<ObservedNode, String> {
        let accessible = proxy(bus, &object, "org.a11y.atspi.Accessible")?;
        let name: String = accessible
            .get_property("Name")
            .map_err(|_| "desktop_accessibility_object_unavailable")?;
        let role: String = accessible
            .call("GetRoleName", &())
            .map_err(|_| "desktop_accessibility_object_unavailable")?;
        let interfaces: Vec<String> = accessible
            .call("GetInterfaces", &())
            .map_err(|_| "desktop_accessibility_object_unavailable")?;
        let states: Vec<u32> = accessible
            .call("GetState", &())
            .map_err(|_| "desktop_accessibility_object_unavailable")?;
        if has_state(&states, 6)
            || has_state(&states, 27)
            || !has_state(&states, 25)
            || !has_state(&states, 30)
        {
            return Err("desktop_accessibility_object_hidden_or_stale".into());
        }
        let (pid, process_started) = process(bus, &object.0)?;
        let actions = if interfaces.iter().any(|v| v == "org.a11y.atspi.Action") {
            let values: Vec<(String, String, String)> =
                proxy(bus, &object, "org.a11y.atspi.Action")?
                    .call("GetActions", &())
                    .map_err(|_| "desktop_accessibility_actions_unavailable")?;
            values
                .into_iter()
                .take(20)
                .map(|v| v.0.chars().take(200).collect())
                .collect()
        } else {
            vec![]
        };
        let editable = has_state(&states, 7)
            && interfaces
                .iter()
                .any(|v| v == "org.a11y.atspi.EditableText");
        Ok(ObservedNode {
            public: Node {
                id: uuid::Uuid::new_v4().to_string(),
                application_pid: pid,
                name: name.chars().take(500).collect(),
                role: role.chars().take(100).collect(),
                actions,
                editable,
                focused: has_state(&states, 12),
            },
            object: object.clone(),
            process_started,
            interfaces,
            enabled: has_state(&states, 8) && has_state(&states, 24),
        })
    }
    pub(super) fn observe(payload: Guarded<Observe>) -> Result<Snapshot, String> {
        let gate = admit(&payload.execution, false)?;
        let limit = payload.request.max_nodes.unwrap_or(150);
        if limit == 0 || limit > 300 {
            return Err("desktop_accessibility_limit_invalid".into());
        }
        let bus = bus()?;
        let root = (
            "org.a11y.atspi.Registry".into(),
            OwnedObjectPath::try_from("/org/a11y/atspi/accessible/root")
                .map_err(|_| "desktop_accessibility_unavailable")?,
        );
        let apps: Vec<Object> = proxy(&bus, &root, "org.a11y.atspi.Accessible")?
            .call("GetChildren", &())
            .map_err(|_| "desktop_accessibility_registry_unavailable")?;
        let mut pending = VecDeque::new();
        for app in apps.into_iter().take(100) {
            if process(&bus, &app.0).is_ok_and(|(pid, _)| {
                payload
                    .request
                    .application_pid
                    .is_none_or(|expected| expected == pid)
            }) {
                pending.push_back(app);
            }
        }
        let mut nodes = BTreeMap::new();
        let mut seen = HashSet::new();
        let deadline = Instant::now() + Duration::from_secs(8);
        while let Some(object) = pending.pop_front() {
            gate.check()?;
            if nodes.len() >= limit || Instant::now() >= deadline {
                pending.push_front(object);
                break;
            }
            if !seen.insert((object.0.clone(), object.1.clone())) {
                continue;
            }
            if let Ok(node) = inspect(&bus, object.clone()) {
                nodes.insert(node.public.id.clone(), node);
            }
            if let Ok(accessible) = proxy(&bus, &object, "org.a11y.atspi.Accessible") {
                let count: i32 = accessible.get_property("ChildCount").unwrap_or(0);
                for index in 0..count.clamp(0, 300) {
                    gate.check()?;
                    if pending.len() >= 1000 || Instant::now() >= deadline {
                        break;
                    }
                    if let Ok(child) = accessible.call::<_, _, Object>("GetChildAtIndex", &(index,))
                    {
                        if child.0 == object.0 {
                            pending.push_back(child);
                        }
                    }
                }
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let public = nodes.values().map(|node| node.public.clone()).collect();
        let mut observations = OBSERVATIONS
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| "desktop_accessibility_busy")?;
        observations
            .retain(|_, observation| observation.created.elapsed() < Duration::from_secs(30));
        if observations.len() >= 128 {
            return Err("desktop_accessibility_capacity".into());
        }
        observations.insert(
            id.clone(),
            Observation {
                execution: payload.execution,
                created: Instant::now(),
                nodes,
            },
        );
        Ok(Snapshot {
            observation_id: id,
            nodes: public,
            expires_in_ms: 30000,
            truncated: !pending.is_empty(),
            backend: "at-spi",
        })
    }
    pub(super) fn action(payload: Guarded<Action>) -> Result<bool, String> {
        let _input = crate::commands::desktop_target::lock_input()?;
        let gate = admit(&payload.execution, true)?;
        let request = payload.request;
        if request
            .value
            .as_ref()
            .is_some_and(|value| value.len() > 50_000 || value.contains('\0'))
        {
            return Err("desktop_accessibility_value_invalid".into());
        }
        let observation = OBSERVATIONS
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| "desktop_accessibility_busy")?
            .remove(&request.observation_id)
            .ok_or("desktop_accessibility_observation_missing_or_consumed")?;
        if observation.execution != payload.execution
            || observation.created.elapsed() >= Duration::from_secs(30)
        {
            return Err("desktop_accessibility_observation_expired_or_changed".into());
        }
        let observed = observation
            .nodes
            .get(&request.node_id)
            .ok_or("desktop_accessibility_node_not_observed")?;
        let bus = bus()?;
        let current = inspect(&bus, observed.object.clone())?;
        if !current.enabled { return Err("desktop_accessibility_target_disabled".into()); }
        if observed.process_started != current.process_started
            || observed.public.application_pid != current.public.application_pid
            || observed.public.name != current.public.name
            || observed.public.role != current.public.role
            || observed.public.actions != current.public.actions
            || observed.interfaces != current.interfaces
        {
            return Err("desktop_accessibility_target_changed".into());
        }
        gate.check()?;
        let result = match request.action {
            ActionKind::Invoke => {
                let index = request.action_index.unwrap_or(0);
                if index >= current.public.actions.len() {
                    return Err("desktop_accessibility_action_not_observed".into());
                }
                proxy(&bus, &current.object, "org.a11y.atspi.Action")?
                    .call("DoAction", &(index as i32,))
            }
            ActionKind::SetText => {
                if !current.public.editable {
                    return Err("desktop_accessibility_target_not_editable".into());
                }
                let value = request.value.ok_or("desktop_accessibility_value_missing")?;
                proxy(&bus, &current.object, "org.a11y.atspi.EditableText")?
                    .call("SetTextContents", &(value,))
            }
            ActionKind::Focus => {
                proxy(&bus, &current.object, "org.a11y.atspi.Component")?.call("GrabFocus", &())
            }
        };
        result.map_err(|_| "desktop_accessibility_action_failed_outcome_unknown".into())
    }
    static WINDOWS: OnceLock<Mutex<BTreeMap<u64, (Object, Instant)>>> = OnceLock::new();
    fn window(bus: &Connection, object: &Object, id: u64) -> Result<crate::commands::desktop_target::WindowTarget,String> {
        let accessible=proxy(bus,object,"org.a11y.atspi.Accessible")?;
        let states:Vec<u32>=accessible.call("GetState",&()).map_err(|_|"desktop_wayland_window_unavailable")?;
        if !has_state(&states,1) || !has_state(&states,25) || !has_state(&states,30) || has_state(&states,6) || has_state(&states,27) {
            return Err("desktop_wayland_target_not_active".into());
        }
        let component=proxy(bus,object,"org.a11y.atspi.Component")?;
        let (x,y,width,height):(i32,i32,i32,i32)=component.call("GetExtents",&(0_u32,)).map_err(|_|"desktop_wayland_geometry_unavailable")?;
        if width<=0 || height<=0 || x.unsigned_abs()>100000 || y.unsigned_abs()>100000 {return Err("desktop_wayland_geometry_unavailable".into());}
        let (pid,start)=process(bus,&object.0)?;
        let target=crate::commands::desktop_target::WindowTarget{window_id:id,process_id:pid,process_started:start,x,y,width:width as u32,height:height as u32,focused:true};
        super::portal::verify_mapping(&target)?;
        Ok(target)
    }
    pub(crate) fn wayland_target(requested: Option<u64>) -> Result<crate::commands::desktop_target::WindowTarget,String> {
        let bus=bus()?;
        if let Some(id)=requested {
            let object=WINDOWS.get_or_init(Mutex::default).lock().map_err(|_|"desktop_wayland_busy")?
                .get(&id).filter(|(_,time)|time.elapsed()<Duration::from_secs(60)).map(|(object,_)|object.clone()).ok_or("desktop_wayland_observation_expired")?;
            return window(&bus,&object,id);
        }
        let deadline=Instant::now()+Duration::from_secs(8);
        let root=("org.a11y.atspi.Registry".into(),OwnedObjectPath::try_from("/org/a11y/atspi/accessible/root").map_err(|_|"desktop_accessibility_unavailable")?);
        let apps:Vec<Object>=proxy(&bus,&root,"org.a11y.atspi.Accessible")?.call("GetChildren",&()).map_err(|_|"desktop_accessibility_registry_unavailable")?;
        let mut candidates=Vec::new();
        for app in apps.into_iter().take(100) {
            if Instant::now()>=deadline { return Err("desktop_wayland_observation_timeout".into()); }
            let accessible=proxy(&bus,&app,"org.a11y.atspi.Accessible")?;
            let count:i32=accessible.get_property("ChildCount").unwrap_or(0);
            for index in 0..count.clamp(0,50) {
                if Instant::now()>=deadline {return Err("desktop_wayland_observation_timeout".into());}
                let Ok(object)=accessible.call::<_,_,Object>("GetChildAtIndex",&(index,)) else {continue};
                if object.0!=app.0 {continue;}
                // IDs are opaque safe integers, never exposed DBus service/path handles.
                use sha2::{Digest,Sha256};
                let digest=Sha256::digest(format!("{}:{}",object.0,object.1));
                let id=u64::from_be_bytes(digest[..8].try_into().map_err(|_|"desktop_wayland_identity_invalid")?) & 0x001f_ffff_ffff_ffff;
                if let Ok(target)=window(&bus,&object,id) {candidates.push((target,object));}
            }
        }
        if candidates.len()!=1 {return Err("desktop_wayland_active_window_not_unique_or_unmapped".into());}
        let (target,object)=candidates.pop().ok_or("desktop_wayland_window_unavailable")?;
        let mut windows=WINDOWS.get_or_init(Mutex::default).lock().map_err(|_|"desktop_wayland_busy")?;
        windows.retain(|_,(_,time)|time.elapsed()<Duration::from_secs(60));
        if windows.len()>=128 {return Err("desktop_wayland_observation_capacity".into());}
        if windows.get(&target.window_id).is_some_and(|(previous,_)|*previous!=object) {return Err("desktop_wayland_identity_collision".into());}
        windows.insert(target.window_id,(object,Instant::now()));Ok(target)
    }
    pub(crate) fn wayland_point(id:u64,x:i32,y:i32)->Result<(),String>{
        let target=wayland_target(Some(id))?;
        if i64::from(x)<i64::from(target.x)||i64::from(y)<i64::from(target.y)||i64::from(x)>=i64::from(target.x)+i64::from(target.width)||i64::from(y)>=i64::from(target.y)+i64::from(target.height){return Err("desktop_wayland_point_outside_target".into());}
        let object=WINDOWS.get_or_init(Mutex::default).lock().map_err(|_|"desktop_wayland_busy")?.get(&id).map(|(object,_)|object.clone()).ok_or("desktop_wayland_observation_expired")?;
        let bus=bus()?;
        let hit:Object=proxy(&bus,&object,"org.a11y.atspi.Component")?.call("GetAccessibleAtPoint",&(x,y,0_u32)).map_err(|_|"desktop_wayland_point_unverified")?;
        if hit.0!=object.0 || hit.1.as_str()=="/org/a11y/atspi/null" {return Err("desktop_wayland_point_unverified".into());}
        Ok(())
    }
    pub(super) fn status() -> Result<serde_json::Value, String> {
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland");
        Ok(
            serde_json::json!({"backend":if wayland{"wayland"}else{"x11"},"semanticInput":bus().is_ok(),"windowInput":!wayland,"portal":portal::status(),"pointerReason":if wayland{Some("target_mapping_unavailable")}else{None}}),
        )
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn atspi_state_bits_are_decoded_across_words() {
            assert!(super::has_state(&[1 << 25, 1], 25));
            assert!(super::has_state(&[1 << 25, 1], 32));
            assert!(!super::has_state(&[], 25));
        }
    }
}
