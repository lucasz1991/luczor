//! Explicit OS consent and a session-bound XDG portal. No renderer can forge a portal handle.
//! AT-SPI semantic actions work independently; pointer injection requires a verified mapping.
use crate::commands::execution::{admit, ExecutionPermit};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex, OnceLock,
    },
    time::Duration,
};
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::{OwnedObjectPath, OwnedValue, Value},
};
const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
struct Session {
    connection: Connection,
    path: OwnedObjectPath,
    execution: ExecutionPermit,
    streams: Vec<Stream>,
    devices: u32,
}
#[derive(Clone)]
struct Stream { node:u32, serial:Option<u64>, position:Option<(i32,i32)>, size:Option<(i32,i32)> }
static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);
type Values = HashMap<String, OwnedValue>;
fn request<B: serde::Serialize + zbus::zvariant::DynamicType>(
    connection: &Connection,
    interface: &str,
    method: &str,
    body: &B,
    token: &str,
) -> Result<Values, String> {
    let unique = connection
        .unique_name()
        .ok_or("desktop_portal_bus_unavailable")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let path = format!("{PATH}/request/{unique}/{token}");
    let response = Proxy::new(
        connection,
        PORTAL,
        path.as_str(),
        "org.freedesktop.portal.Request",
    )
    .map_err(|_| "desktop_portal_request_failed")?;
    // Subscribe before method invocation: an immediate OS denial must not be lost.
    let mut messages = response
        .receive_signal("Response")
        .map_err(|_| "desktop_portal_request_failed")?;
    let portal = Proxy::new(connection, PORTAL, PATH, interface)
        .map_err(|_| "desktop_portal_unavailable")?;
    let actual: OwnedObjectPath = portal
        .call(method, body)
        .map_err(|_| "desktop_portal_request_failed")?;
    if actual.as_str() != path {
        return Err("desktop_portal_request_handle_mismatch".into());
    }
    let message = messages.next().ok_or("desktop_portal_request_closed")?;
    let (code, values): (u32, Values) = message
        .body()
        .deserialize()
        .map_err(|_| "desktop_portal_response_invalid")?;
    if code != 0 {
        return Err(if code == 1 {
            "desktop_portal_consent_cancelled"
        } else {
            "desktop_portal_consent_denied"
        }
        .into());
    }
    Ok(values)
}
fn token() -> String {
    format!("luczor_{}", uuid::Uuid::new_v4().simple())
}
fn establish(connection: Connection, execution: ExecutionPermit) -> Result<Session, String> {
    let gate = admit(&execution, false)?;
    let create = token();
    let session_token = token();
    let mut options = HashMap::new();
    options.insert("handle_token", Value::from(create.as_str()));
    options.insert("session_handle_token", Value::from(session_token.as_str()));
    let mut response = request(
        &connection,
        "org.freedesktop.portal.RemoteDesktop",
        "CreateSession",
        &(options,),
        &create,
    )?;
    // The portal deliberately returns this historical field as a string, not
    // a D-Bus object-path variant (RemoteDesktop v2 contract).
    let handle = String::try_from(
        response
            .remove("session_handle")
            .ok_or("desktop_portal_session_missing")?,
    )
    .map_err(|_| "desktop_portal_session_invalid")?;
    let path = OwnedObjectPath::try_from(handle).map_err(|_| "desktop_portal_session_invalid")?;
    gate.check()?;
    let select = token();
    let mut options = HashMap::new();
    options.insert("handle_token", Value::from(select.as_str()));
    options.insert("types", Value::from(3_u32));
    let portal = Proxy::new(
        &connection,
        PORTAL,
        PATH,
        "org.freedesktop.portal.RemoteDesktop",
    )
    .map_err(|_| "desktop_portal_unavailable")?;
    if portal.get_property::<u32>("version").unwrap_or(1) >= 2 {
        options.insert("persist_mode", Value::from(1_u32));
    }
    drop(portal);
    request(
        &connection,
        "org.freedesktop.portal.RemoteDesktop",
        "SelectDevices",
        &(&path, options),
        &select,
    )?;
    let sources = token();
    let mut options = HashMap::new();
    options.insert("handle_token", Value::from(sources.as_str()));
    options.insert("types", Value::from(1_u32));
    options.insert("multiple", Value::from(false));
    request(
        &connection,
        "org.freedesktop.portal.ScreenCast",
        "SelectSources",
        &(&path, options),
        &sources,
    )?;
    gate.check()?;
    let start = token();
    let mut options = HashMap::new();
    options.insert("handle_token", Value::from(start.as_str()));
    let mut response = request(
        &connection,
        "org.freedesktop.portal.RemoteDesktop",
        "Start",
        &(&path, "", options),
        &start,
    )?;
    let streams = if let Some(streams) = response.remove("streams") {
        Vec::<(u32, HashMap<String, OwnedValue>)>::try_from(streams)
            .map_err(|_| "desktop_portal_streams_invalid")?
            .into_iter().map(|(node,mut fields)|Stream{node,
                serial:fields.remove("pipewire-serial").and_then(|v|u64::try_from(v).ok()),
                position:fields.remove("position").and_then(|v|<(i32,i32)>::try_from(v).ok()),
                size:fields.remove("size").and_then(|v|<(i32,i32)>::try_from(v).ok())}).collect()
    } else {
        vec![]
    };
    let devices=response.remove("devices").and_then(|v|u32::try_from(v).ok()).unwrap_or(0);
    gate.check()?;
    Ok(Session {
        connection,
        path,
        execution,
        streams,
        devices,
    })
}
pub(super) fn setup(execution: ExecutionPermit) -> Result<serde_json::Value, String> {
    close()?;
    let generation = GENERATION.load(Ordering::Acquire);
    let connection = super::linux::session()?;
    let timeout_connection = connection.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = establish(connection.clone(), execution);
        if sender.send(result).is_err() {
            let _ = connection.close();
        }
    });
    let session = match receiver.recv_timeout(Duration::from_secs(90)) {
        Ok(result) => result?,
        Err(_) => {
            let _ = timeout_connection.close();
            return Err("desktop_portal_consent_timeout".into());
        }
    };
    let streams = session.streams.len();
    let pointer = session.devices & 2 != 0 && session.streams.iter().any(|stream| stream.position.is_some() && stream.size.is_some());
    let mut slot = SESSION
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "desktop_portal_busy")?;
    if generation != GENERATION.load(Ordering::Acquire) {
        let _ = session.connection.close();
        return Err("desktop_portal_setup_superseded".into());
    }
    admit(&session.execution, false)?.check()?;
    *slot = Some(session);
    Ok(
        serde_json::json!({"state":"consent_granted","streams":streams,"pointerInput":pointer,"reason":if pointer{"observation_required"}else{"target_mapping_unavailable"}}),
    )
}
pub(super) fn close() -> Result<(), String> {
    GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Some(session) = SESSION
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "desktop_portal_busy")?
        .take()
    {
        if let Ok(proxy) = Proxy::new(
            &session.connection,
            PORTAL,
            session.path.as_str(),
            "org.freedesktop.portal.Session",
        ) {
            let _: Result<(), _> = proxy.call("Close", &());
        }
        let _ = session.connection.close();
    }
    Ok(())
}
pub(super) fn status() -> &'static str {
    let Ok(session) = SESSION.get_or_init(Mutex::default).lock() else {
        return "unavailable";
    };
    match &*session {
        Some(session) if admit(&session.execution, false).is_ok() => "consent_granted",
        Some(_) => "scope_changed",
        None => "needs_os_consent",
    }
}

fn mapped<'a>(session:&'a Session,target:&crate::commands::desktop_target::WindowTarget)->Result<&'a Stream,String>{
    admit(&session.execution,false)?.check()?;
    let mut matches=session.streams.iter().filter(|stream| {
        let (Some((x,y)),Some((width,height)))=(stream.position,stream.size) else{return false};
        width>0 && height>0 && i64::from(target.x)>=i64::from(x) && i64::from(target.y)>=i64::from(y)
            && i64::from(target.x)+i64::from(target.width)<=i64::from(x)+i64::from(width)
            && i64::from(target.y)+i64::from(target.height)<=i64::from(y)+i64::from(height)
    });
    let stream=matches.next().ok_or("desktop_wayland_target_mapping_unavailable")?;
    if matches.next().is_some(){return Err("desktop_wayland_target_mapping_ambiguous".into());}
    Ok(stream)
}
pub(crate) fn verify_mapping(target:&crate::commands::desktop_target::WindowTarget)->Result<(),String>{
    let lock=SESSION.get_or_init(Mutex::default).lock().map_err(|_|"desktop_portal_busy")?;
    mapped(lock.as_ref().ok_or("desktop_portal_consent_required")?,target)?;Ok(())
}
fn with_input<T>(guard:&crate::commands::desktop_target::DesktopActionGuard,devices:u32,perform:impl FnOnce(&Proxy<'_>,&Session,&Stream)->Result<T,String>)->Result<T,String>{
    guard.check()?;
    let lock=SESSION.get_or_init(Mutex::default).lock().map_err(|_|"desktop_portal_busy")?;
    let session=lock.as_ref().ok_or("desktop_portal_consent_required")?;
    if session.devices & devices != devices {return Err("desktop_portal_input_not_granted".into());}
    if session.execution.session_id!=guard.permit().session_id || session.execution.generation!=guard.permit().generation {
        return Err("desktop_portal_execution_changed".into());
    }
    let stream=mapped(session,guard.target())?;
    let proxy=Proxy::new(&session.connection,PORTAL,PATH,"org.freedesktop.portal.RemoteDesktop").map_err(|_|"desktop_portal_unavailable")?;
    perform(&proxy,session,stream)
}
pub(crate) fn move_to(guard:&crate::commands::desktop_target::DesktopActionGuard,x:i32,y:i32)->Result<(),String>{
    guard.point(x,y)?;
    with_input(guard,2,|proxy,session,stream|{
        let (left,top)=stream.position.ok_or("desktop_wayland_mapping_unavailable")?;
        proxy.call::<_,_,()>("NotifyPointerMotionAbsolute",&(&session.path,HashMap::<String,Value>::new(),stream.node,f64::from(x-left),f64::from(y-top)))
            .map_err(|_|"desktop_portal_motion_failed_outcome_unknown".into())
    })
}
pub(crate) fn click(guard:&crate::commands::desktop_target::DesktopActionGuard,x:i32,y:i32,button:enigo::Button,double:bool)->Result<(),String>{
    let code=match button{enigo::Button::Left=>272_i32,enigo::Button::Right=>273,enigo::Button::Middle=>274,_=>return Err("desktop_portal_button_invalid".into())};
    move_to(guard,x,y)?;
    for _ in 0..if double{2}else{1} {
        guard.point(x,y)?;
        with_input(guard,2,|proxy,session,_|{
            let pressed=proxy.call::<_,_,()>("NotifyPointerButton",&(&session.path,HashMap::<String,Value>::new(),code,1_u32));
            let released=proxy.call::<_,_,()>("NotifyPointerButton",&(&session.path,HashMap::<String,Value>::new(),code,0_u32));
            pressed.and(released).map_err(|_|"desktop_portal_click_failed_outcome_unknown".into())
        })?;
    }Ok(())
}
fn keysym(key:enigo::Key)->Result<i32,String>{use enigo::Key;Ok(match key{
    Key::Return=>0xff0d,Key::Tab=>0xff09,Key::Escape=>0xff1b,Key::Space=>32,Key::Backspace=>0xff08,Key::Delete=>0xffff,
    Key::UpArrow=>0xff52,Key::DownArrow=>0xff54,Key::LeftArrow=>0xff51,Key::RightArrow=>0xff53,Key::Home=>0xff50,Key::End=>0xff57,
    Key::Control=>0xffe3,Key::Alt=>0xffe9,Key::Shift=>0xffe1,Key::Meta=>0xffeb,
    Key::Unicode(c)=>{let value=c as u32;if value<0x100 {value as i32}else{(value|0x01000000) as i32}},_=>return Err("desktop_portal_key_unsupported".into())})}
pub(crate) fn press(guard:&crate::commands::desktop_target::DesktopActionGuard,key:enigo::Key,modifiers:&[enigo::Key])->Result<(),String>{
    let key=keysym(key)?;let modifiers=modifiers.iter().map(|key|keysym(*key)).collect::<Result<Vec<_>,_>>()?;
    with_input(guard,1,|proxy,session,_|{
        let emit=|key:i32,state:u32|proxy.call::<_,_,()>("NotifyKeyboardKeysym",&(&session.path,HashMap::<String,Value>::new(),key,state));
        let mut pressed=Vec::new();let result=(||{for modifier in modifiers{emit(modifier,1)?;pressed.push(modifier);}emit(key,1)?;emit(key,0)})();
        // Release keys even after a transport error; never leave modifiers held.
        let _=emit(key,0);let mut release_error=false;for modifier in pressed.into_iter().rev(){release_error|=emit(modifier,0).is_err();}
        if result.is_err()||release_error {Err("desktop_portal_key_failed_outcome_unknown".into())}else{Ok(())}
    })
}
pub(crate) fn scroll(guard:&crate::commands::desktop_target::DesktopActionGuard,amount:i32,axis:enigo::Axis)->Result<(),String>{
    let target=guard.target();let x=target.x+(target.width/2) as i32;let y=target.y+(target.height/2) as i32;move_to(guard,x,y)?;
    with_input(guard,2,|proxy,session,_|proxy.call::<_,_,()>("NotifyPointerAxisDiscrete",&(&session.path,HashMap::<String,Value>::new(),if axis==enigo::Axis::Horizontal{1_u32}else{0},amount)).map_err(|_|"desktop_portal_scroll_failed_outcome_unknown".into()))
}
