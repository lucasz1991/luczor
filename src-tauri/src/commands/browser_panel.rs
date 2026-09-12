//! Native child webview placement. Only the trusted renderer can move/show it.
use super::{CallerWebview, BROWSER_WEBVIEW_LABEL};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Webview};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelLayout {
    visible: bool,
    project_id: String,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    #[serde(default = "default_zoom")]
    zoom: f64,
}

fn default_zoom() -> f64 {
    1.0
}

impl Default for PanelLayout {
    fn default() -> Self {
        Self {
            visible: false,
            project_id: String::new(),
            left: 0.0,
            top: 0.0,
            width: 0.0,
            height: 0.0,
            zoom: default_zoom(),
        }
    }
}
fn layout() -> &'static Mutex<PanelLayout> {
    static LAYOUT: OnceLock<Mutex<PanelLayout>> = OnceLock::new();
    LAYOUT.get_or_init(Mutex::default)
}
impl PanelLayout {
    fn valid(&self) -> bool {
        [self.left, self.top, self.width, self.height]
            .iter()
            .all(|n| n.is_finite() && *n >= 0.0 && *n <= 32768.0)
            && self.width >= 1.0
            && self.height >= 1.0
            && self.zoom.is_finite()
            && (0.05..=4.0).contains(&self.zoom)
            && self.project_id.len() <= 200
    }
}
pub fn apply(app: &AppHandle, browser: &Webview, project_id: &str) -> Result<(), String> {
    // Older device jobs can still own a detached browser. Never move or hide it.
    if browser.window().label() != "main" {
        return Ok(());
    }
    let state = layout()
        .lock()
        .map_err(|_| "browser_panel_layout_unavailable")?
        .clone();
    if !state.visible || state.project_id != project_id {
        return browser.hide().map_err(|e| e.to_string());
    }
    let main = app
        .get_window("main")
        .ok_or("browser_panel_main_unavailable")?;
    let size = main
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(main.scale_factor().map_err(|e| e.to_string())?);
    if state.left + state.width > size.width + 1.0 || state.top + state.height > size.height + 1.0 {
        return browser.hide().map_err(|e| e.to_string());
    }
    browser
        .set_bounds(Rect {
            position: LogicalPosition::new(state.left, state.top).into(),
            size: LogicalSize::new(state.width, state.height).into(),
        })
        .map_err(|e| e.to_string())?;
    browser.set_zoom(state.zoom).map_err(|e| e.to_string())?;
    browser.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_panel_layout(
    window: CallerWebview,
    app: AppHandle,
    payload: PanelLayout,
) -> Result<(), String> {
    super::ensure_main_webview(&window)?;
    if !payload.valid() {
        return Err("browser_panel_bounds_invalid".into());
    }
    *layout()
        .lock()
        .map_err(|_| "browser_panel_layout_unavailable")? = payload;
    if let Some(browser) = app.get_webview(BROWSER_WEBVIEW_LABEL) {
        let project = super::workflow_browser::panel_project_id();
        apply(&app, &browser, project.as_deref().unwrap_or(""))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_panel_status(window: CallerWebview, app: AppHandle) -> Result<Value, String> {
    super::ensure_main_webview(&window)?;
    let Some(browser) = app.get_webview(BROWSER_WEBVIEW_LABEL) else {
        return Ok(json!({"open":false}));
    };
    if browser.window().label() != "main" {
        return Ok(json!({"open":false}));
    }
    let mut url = browser.url().map_err(|e| e.to_string())?;
    let _ = url.set_username("");
    let _ = url.set_password(None);
    Ok(
        json!({"open":true,"projectId":super::workflow_browser::panel_project_id(),"url":url.as_str()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_native_bounds() {
        let mut state = PanelLayout {
            width: 400.0,
            height: 500.0,
            ..Default::default()
        };
        assert!(state.valid());
        state.left = f64::NAN;
        assert!(!state.valid());
        state.left = -1.0;
        assert!(!state.valid());
        state.left = 0.0;
        state.width = f64::INFINITY;
        assert!(!state.valid());
        state.width = 400.0;
        state.zoom = 0.04;
        assert!(!state.valid());
        state.zoom = 0.5;
        assert!(state.valid());
    }
}

#[cfg(all(test, windows, feature = "native-browser-smoke"))]
#[path = "browser_panel_smoke.rs"]
mod native_smoke;
