//! X11 targets are verified natively. Wayland never falls back to XWayland global input.
use super::desktop_target::WindowTarget;
use x11rb::{
    connection::Connection,
    protocol::xproto::{AtomEnum, ConnectionExt, MapState},
    rust_connection::RustConnection,
};
pub(super) fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland")
}

fn connect() -> Result<(RustConnection, u32), String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland")
    {
        return Err("desktop_wayland_portal_target_required".into());
    }
    let (connection, screen) =
        x11rb::connect(None).map_err(|_| "desktop_x11_connection_unavailable")?;
    let root = connection.setup().roots[screen].root;
    Ok((connection, root))
}
fn property(
    connection: &RustConnection,
    window: u32,
    name: &str,
    kind: AtomEnum,
) -> Result<Vec<u32>, String> {
    let atom = connection
        .intern_atom(true, name.as_bytes())
        .map_err(|_| "desktop_x11_property_unavailable")?
        .reply()
        .map_err(|_| "desktop_x11_property_unavailable")?
        .atom;
    if atom == 0 {
        return Err("desktop_x11_property_unavailable".into());
    }
    let reply = connection
        .get_property(false, window, atom, kind, 0, 4096)
        .map_err(|_| "desktop_x11_property_unavailable")?
        .reply()
        .map_err(|_| "desktop_x11_property_unavailable")?;
    reply
        .value32()
        .map(|values| values.collect())
        .ok_or("desktop_x11_property_invalid".into())
}
fn process_start(pid: u32) -> Result<u64, String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map_err(|_| "desktop_process_identity_unavailable")?;
    let fields = stat
        .rsplit_once(") ")
        .ok_or("desktop_process_identity_invalid")?
        .1;
    fields
        .split_whitespace()
        .nth(19)
        .ok_or("desktop_process_identity_invalid")?
        .parse()
        .map_err(|_| "desktop_process_identity_invalid".into())
}
fn geometry(
    connection: &RustConnection,
    root: u32,
    window: u32,
) -> Result<(i32, i32, u32, u32), String> {
    let attributes = connection
        .get_window_attributes(window)
        .map_err(|_| "desktop_target_unavailable")?
        .reply()
        .map_err(|_| "desktop_target_unavailable")?;
    if attributes.map_state != MapState::VIEWABLE {
        return Err("desktop_target_not_visible".into());
    }
    let bounds = connection
        .get_geometry(window)
        .map_err(|_| "desktop_target_unavailable")?
        .reply()
        .map_err(|_| "desktop_target_unavailable")?;
    let position = connection
        .translate_coordinates(window, root, 0, 0)
        .map_err(|_| "desktop_target_unavailable")?
        .reply()
        .map_err(|_| "desktop_target_unavailable")?;
    if !position.same_screen || bounds.width == 0 || bounds.height == 0 {
        return Err("desktop_target_geometry_unavailable".into());
    }
    Ok((
        i32::from(position.dst_x),
        i32::from(position.dst_y),
        u32::from(bounds.width),
        u32::from(bounds.height),
    ))
}
pub(super) fn read_target(requested: Option<u64>) -> Result<WindowTarget, String> {
    if is_wayland() {
        return super::desktop_accessibility::linux::wayland_target(requested);
    }
    let (connection, root) = connect()?;
    let active = property(&connection, root, "_NET_ACTIVE_WINDOW", AtomEnum::WINDOW)?
        .first()
        .copied()
        .filter(|v| *v != 0)
        .ok_or("desktop_focused_target_unavailable")?;
    let window = requested
        .map(u32::try_from)
        .transpose()
        .map_err(|_| "desktop_window_id_invalid")?
        .unwrap_or(active);
    if window != active {
        return Err("desktop_target_must_be_focused".into());
    }
    let pid = property(&connection, window, "_NET_WM_PID", AtomEnum::CARDINAL)?
        .first()
        .copied()
        .filter(|v| *v != 0)
        .ok_or("desktop_process_identity_unavailable")?;
    let (x, y, width, height) = geometry(&connection, root, window)?;
    Ok(WindowTarget {
        window_id: u64::from(window),
        process_id: pid,
        process_started: process_start(pid)?,
        x,
        y,
        width,
        height,
        focused: true,
    })
}
pub(super) fn point_targets_window(target: u64, x: i32, y: i32) -> Result<(), String> {
    if is_wayland() {
        return super::desktop_accessibility::linux::wayland_point(target, x, y);
    }
    let (connection, root) = connect()?;
    let stacking = property(
        &connection,
        root,
        "_NET_CLIENT_LIST_STACKING",
        AtomEnum::WINDOW,
    )?;
    for window in stacking.into_iter().rev() {
        if let Ok((left, top, width, height)) = geometry(&connection, root, window) {
            if i64::from(x) >= i64::from(left)
                && i64::from(x) < i64::from(left) + i64::from(width)
                && i64::from(y) >= i64::from(top)
                && i64::from(y) < i64::from(top) + i64::from(height)
            {
                return if u64::from(window) == target {
                    Ok(())
                } else {
                    Err("desktop_target_occluded".into())
                };
            }
        }
    }
    Err("desktop_target_point_unverified".into())
}
pub(super) fn pointer_position() -> Result<(i32, i32), String> {
    let (connection, root) = connect()?;
    let pointer = connection
        .query_pointer(root)
        .map_err(|_| "desktop_pointer_unavailable")?
        .reply()
        .map_err(|_| "desktop_pointer_unavailable")?;
    if !pointer.same_screen {
        return Err("desktop_pointer_screen_changed".into());
    }
    Ok((i32::from(pointer.root_x), i32::from(pointer.root_y)))
}

#[cfg(test)]
mod tests {
    #[test]
    fn linux_process_start_identity_is_available_for_own_process() {
        assert!(super::process_start(std::process::id()).unwrap() > 0);
    }
}
