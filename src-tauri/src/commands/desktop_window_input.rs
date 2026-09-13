//! Targeted classic Win32 control messages. Never SendInput, SetFocus or a system cursor.
//! Delivery is not evidence of application success; the caller must observe the result.
use super::desktop_target::DesktopActionGuard;
use windows_sys::Win32::{
    Foundation::{HWND, POINT},
    Graphics::Gdi::ScreenToClient,
    UI::Controls::{EM_CHARFROMPOS, EM_LINESCROLL, EM_SETSEL},
    UI::Input::KeyboardAndMouse::IsWindowEnabled,
    UI::WindowsAndMessaging::*,
};

fn unsupported() -> String {
    "desktop_control_isolated_action_unsupported_use_internal_browser_or_supported_control".into()
}

fn message(window: HWND, code: u32, word: usize, long: isize) -> Result<usize, String> {
    let mut result = 0usize;
    // No pointer parameters: bounded synchronous scalar-only messages to one verified control.
    if unsafe {
        SendMessageTimeoutW(
            window,
            code,
            word,
            long,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            150,
            &mut result,
        )
    } == 0
    {
        return Err(
            "desktop_control_delivery_unconfirmed_do_not_repeat_without_observation".into(),
        );
    }
    Ok(result)
}

fn control(guard: &DesktopActionGuard) -> Result<(HWND, String, POINT), String> {
    guard.check()?;
    let (x, y) = guard.virtual_point()?;
    guard.point(x, y)?;
    let root = guard.target().window_id as usize as HWND;
    let mut window = root;
    let mut point = POINT { x, y };
    unsafe {
        for _ in 0..16 {
            point = POINT { x, y };
            if ScreenToClient(window, &mut point) == 0 {
                return Err(unsupported());
            }
            let child = ChildWindowFromPointEx(
                window,
                point,
                CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
            );
            if child.is_null() || child == window {
                break;
            }
            window = child;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        if pid != guard.target().process_id
            || GetAncestor(window, GA_ROOT) != root
            || IsWindowEnabled(window) == 0
        {
            return Err("desktop_control_target_changed".into());
        }
        let mut class = [0u16; 256];
        let len = GetClassNameW(window, class.as_mut_ptr(), class.len() as i32);
        if len <= 0 {
            return Err(unsupported());
        }
        Ok((
            window,
            String::from_utf16_lossy(&class[..len as usize]).to_ascii_lowercase(),
            point,
        ))
    }
}

fn edit(class: &str) -> bool {
    class == "edit" || class.starts_with("richedit")
}

pub fn click(guard: &DesktopActionGuard, button: &str, double: bool) -> Result<(), String> {
    if button != "left" || double {
        return Err(unsupported());
    }
    let (window, class, point) = control(guard)?;
    guard.check()?;
    if class == "button" {
        message(window, BM_CLICK, 0, 0)?;
    } else if class == "edit" {
        let pos = ((point.y as u16 as u32) << 16 | point.x as u16 as u32) as isize;
        let index = message(window, EM_CHARFROMPOS, 0, pos)? & 0xffff;
        message(window, EM_SETSEL, index, index as isize)?;
    } else {
        return Err(unsupported());
    }
    Ok(())
}

pub fn text(guard: &DesktopActionGuard, text: &str) -> Result<(), String> {
    let (window, class, _) = control(guard)?;
    if !edit(&class) {
        return Err(unsupported());
    }
    if unsafe { GetWindowLongW(window, GWL_STYLE) } as u32 & ES_READONLY as u32 != 0 {
        return Err("desktop_control_read_only".into());
    }
    for character in text.encode_utf16() {
        guard.check()?;
        message(window, WM_CHAR, character as usize, 1)?;
    }
    Ok(())
}

pub fn key(guard: &DesktopActionGuard, key: &str, modifiers: &[String]) -> Result<(), String> {
    let (window, class, _) = control(guard)?;
    if !edit(&class) {
        return Err(unsupported());
    }
    if modifiers.len() == 1
        && ["control", "ctrl"].contains(&modifiers[0].to_lowercase().as_str())
        && key.eq_ignore_ascii_case("a")
    {
        message(window, EM_SETSEL, 0, -1)?;
        return Ok(());
    }
    if !modifiers.is_empty() {
        return Err(unsupported());
    }
    let character = match key.to_lowercase().as_str() {
        "enter" | "return" => '\r',
        "space" => ' ',
        "backspace" => '\x08',
        _ if key.chars().count() == 1 => key.chars().next().unwrap(),
        _ => return Err(unsupported()),
    };
    text(guard, &character.to_string())
}

pub fn scroll(guard: &DesktopActionGuard, amount: i32, horizontal: bool) -> Result<(), String> {
    let (window, class, _) = control(guard)?;
    if !edit(&class) {
        return Err(unsupported());
    }
    let (columns, lines) = if horizontal { (amount, 0) } else { (0, amount) };
    message(window, EM_LINESCROLL, columns as usize, lines as isize)?;
    Ok(())
}
