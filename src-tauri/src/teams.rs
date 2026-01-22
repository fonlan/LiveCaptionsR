#![cfg(windows)]

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use windows::{
    core::*,
    Win32::Foundation::{BOOL, HWND, LPARAM, TRUE},
    Win32::System::Com::*,
    Win32::UI::Accessibility::*,
    Win32::UI::WindowsAndMessaging::*,
};

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Information about a Teams window candidate
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamsWindowInfo {
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
}

/// Check if Teams is running
pub fn is_teams_running() -> bool {
    Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq ms-teams.exe", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("ms-teams.exe"))
        .unwrap_or(false)
}

/// Process info structure
struct ProcessInfo {
    pid: u32,
    parent_pid: u32,
    name: String,
    cmdline: String,
}

/// Get all process information using WMIC
fn get_all_processes() -> Vec<ProcessInfo> {
    let output = Command::new("wmic")
        .args([
            "process",
            "get",
            "ProcessId,ParentProcessId,Name,CommandLine",
            "/format:list",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let stdout = match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(e) => {
            eprintln!("[Teams Debug] Failed to get process list: {}", e);
            return Vec::new();
        }
    };

    let mut processes = Vec::new();
    let mut current = ProcessInfo {
        pid: 0,
        parent_pid: 0,
        name: String::new(),
        cmdline: String::new(),
    };

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            // End of one process record
            if current.pid != 0 {
                processes.push(current);
                current = ProcessInfo {
                    pid: 0,
                    parent_pid: 0,
                    name: String::new(),
                    cmdline: String::new(),
                };
            }
            continue;
        }

        if let Some(val) = line.strip_prefix("ProcessId=") {
            current.pid = val.trim().parse().unwrap_or(0);
        } else if let Some(val) = line.strip_prefix("ParentProcessId=") {
            current.parent_pid = val.trim().parse().unwrap_or(0);
        } else if let Some(val) = line.strip_prefix("Name=") {
            current.name = val.trim().to_string();
        } else if let Some(val) = line.strip_prefix("CommandLine=") {
            current.cmdline = val.trim().to_string();
        }
    }

    // Don't forget the last one
    if current.pid != 0 {
        processes.push(current);
    }

    processes
}

/// Find Teams renderer process PIDs using the correct hierarchy:
/// ms-teams.exe → msedgewebview2.exe (direct child) → msedgewebview2.exe with --type=renderer
fn get_teams_renderer_pids() -> Vec<u32> {
    let processes = get_all_processes();

    // Build lookup maps
    let mut pid_to_info: HashMap<u32, &ProcessInfo> = HashMap::new();
    let mut parent_to_children: HashMap<u32, Vec<u32>> = HashMap::new();

    for proc in &processes {
        pid_to_info.insert(proc.pid, proc);
        parent_to_children
            .entry(proc.parent_pid)
            .or_insert_with(Vec::new)
            .push(proc.pid);
    }

    // Step 1: Find ms-teams.exe PIDs
    let teams_pids: Vec<u32> = processes
        .iter()
        .filter(|p| p.name.to_lowercase() == "ms-teams.exe")
        .map(|p| p.pid)
        .collect();

    if teams_pids.is_empty() {
        eprintln!("[Teams Debug] No ms-teams.exe process found");
        return Vec::new();
    }
    eprintln!("[Teams Debug] Found ms-teams.exe PIDs: {:?}", teams_pids);

    // Step 2: Find direct msedgewebview2.exe children of ms-teams.exe
    let mut first_level_webviews: Vec<u32> = Vec::new();
    for &teams_pid in &teams_pids {
        if let Some(children) = parent_to_children.get(&teams_pid) {
            for &child_pid in children {
                if let Some(info) = pid_to_info.get(&child_pid) {
                    if info.name.to_lowercase() == "msedgewebview2.exe" {
                        first_level_webviews.push(child_pid);
                    }
                }
            }
        }
    }
    eprintln!(
        "[Teams Debug] Found {} first-level msedgewebview2.exe processes: {:?}",
        first_level_webviews.len(),
        first_level_webviews
    );

    // Step 3: Find children of first-level webviews that have --type=renderer
    let mut renderer_pids: Vec<u32> = Vec::new();
    for &webview_pid in &first_level_webviews {
        if let Some(children) = parent_to_children.get(&webview_pid) {
            for &child_pid in children {
                if let Some(info) = pid_to_info.get(&child_pid) {
                    if info.name.to_lowercase() == "msedgewebview2.exe"
                        && info.cmdline.contains("--type=renderer")
                    {
                        eprintln!(
                            "[Teams Debug] Found renderer PID {} (parent: {})",
                            child_pid, webview_pid
                        );
                        renderer_pids.push(child_pid);
                    }
                }
            }
        }
    }

    eprintln!(
        "[Teams Debug] Found {} renderer processes",
        renderer_pids.len()
    );
    renderer_pids
}

/// Find all windows belonging to the renderer processes
pub fn find_all_teams_windows() -> Vec<TeamsWindowInfo> {
    let renderer_pids = get_teams_renderer_pids();
    if renderer_pids.is_empty() {
        return Vec::new();
    }

    let target_pids: HashSet<u32> = renderer_pids.into_iter().collect();

    struct EnumData {
        target_pids: HashSet<u32>,
        windows: Vec<TeamsWindowInfo>,
    }

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let data = &mut *(lparam.0 as *mut EnumData);

        let mut window_pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut window_pid));

        if data.target_pids.contains(&window_pid) && IsWindowVisible(hwnd).as_bool() {
            let mut title = [0u16; 512];
            let title_len = GetWindowTextW(hwnd, &mut title);

            // Only include windows with titles
            if title_len > 0 {
                let title_str = String::from_utf16_lossy(&title[..title_len as usize]);

                // Skip very small or empty titles
                if !title_str.trim().is_empty() {
                    eprintln!(
                        "[Teams Debug] Found renderer window (PID {}): '{}'",
                        window_pid, title_str
                    );
                    data.windows.push(TeamsWindowInfo {
                        hwnd: hwnd.0 as isize,
                        pid: window_pid,
                        title: title_str,
                    });
                }
            }
        }
        TRUE // Continue enumeration
    }

    let mut data = EnumData {
        target_pids,
        windows: Vec::new(),
    };

    unsafe {
        let _ = EnumWindows(
            Some(enum_callback),
            LPARAM(&mut data as *mut EnumData as isize),
        );
    }

    data.windows
}

/// Find a single Teams window, returning the first match or None
pub fn find_teams_webview_window() -> Option<HWND> {
    let windows = find_all_teams_windows();
    if windows.is_empty() {
        return None;
    }

    // Return the first window found
    Some(HWND(windows[0].hwnd as *mut _))
}

pub struct TeamsWatcher {
    automation: IUIAutomation,
}

impl TeamsWatcher {
    pub fn new() -> Result<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED).ok();

            let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
                .context("Failed to create IUIAutomation")?;

            Ok(Self { automation })
        }
    }

    pub fn get_element_from_handle(&self, hwnd: HWND) -> Result<IUIAutomationElement> {
        unsafe {
            let element = self
                .automation
                .ElementFromHandle(hwnd)
                .context("Failed to get element from handle")?;
            Ok(element)
        }
    }

    /// Get caption text from Teams window
    pub fn get_caption_text(&self, window: &IUIAutomationElement) -> Result<String> {
        unsafe {
            let text_condition = self
                .automation
                .CreatePropertyCondition(
                    UIA_ControlTypePropertyId,
                    &VARIANT::from(UIA_TextControlTypeId.0 as i32),
                )
                .context("Failed to create text condition")?;

            let elements = window
                .FindAll(TreeScope_Descendants, &text_condition)
                .context("Failed to find text elements")?;

            let count = elements.Length().unwrap_or(0);
            let mut texts = Vec::new();
            let mut seen_texts = HashSet::new();

            for i in 0..count {
                if let Ok(element) = elements.GetElement(i) {
                    if let Ok(name) = element.CurrentName() {
                        let text = name.to_string();
                        if !text.is_empty()
                            && !text.contains("Microsoft Teams")
                            && !text.contains("Live captions")
                            && !text.contains("Turn on")
                            && !text.contains("Turn off")
                            && !text.contains("Settings")
                            && text.len() > 2
                            && !seen_texts.contains(&text)
                        {
                            seen_texts.insert(text.clone());
                            texts.push(text);
                        }
                    }
                }
            }

            if texts.is_empty() {
                if let Ok(text_pattern) =
                    window.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                {
                    if let Ok(range) = text_pattern.DocumentRange() {
                        if let Ok(text) = range.GetText(-1) {
                            let text_str = text.to_string();
                            if !text_str.is_empty() {
                                texts.push(text_str);
                            }
                        }
                    }
                }
            }

            let result = if texts.len() > 3 {
                texts[texts.len() - 3..].join(" ")
            } else {
                texts.join(" ")
            };

            Ok(result)
        }
    }

    /// Find Teams window, with optional specific hwnd
    pub fn find_teams_window_uia(
        &self,
        hwnd_override: Option<isize>,
    ) -> Result<IUIAutomationElement> {
        if let Some(hwnd_val) = hwnd_override {
            let hwnd = HWND(hwnd_val as *mut _);
            return self.get_element_from_handle(hwnd);
        }

        if let Some(hwnd) = find_teams_webview_window() {
            return self.get_element_from_handle(hwnd);
        }

        Err(anyhow::anyhow!(
            "Teams window not found. Make sure Teams is running and you're in a meeting."
        ))
    }
}

pub struct TeamsCaptionStream {
    watcher: TeamsWatcher,
    window: Option<IUIAutomationElement>,
    selected_hwnd: Option<isize>,
    running: Arc<AtomicBool>,
    last_text: String,
    error_count: u32,
}

impl TeamsCaptionStream {
    pub fn new() -> Result<Self> {
        let watcher = TeamsWatcher::new()?;
        Ok(Self {
            watcher,
            window: None,
            selected_hwnd: None,
            running: Arc::new(AtomicBool::new(false)),
            last_text: String::new(),
            error_count: 0,
        })
    }

    /// Set a specific window to monitor (by hwnd)
    pub fn set_window(&mut self, hwnd: isize) {
        self.selected_hwnd = Some(hwnd);
    }

    /// Connect to Teams caption stream
    pub fn connect(&mut self) -> Result<String> {
        self.error_count = 0;

        if !is_teams_running() {
            return Err(anyhow::anyhow!(
                "Microsoft Teams is not running. Please start Teams and join a meeting with captions enabled."
            ));
        }

        match self.watcher.find_teams_window_uia(self.selected_hwnd) {
            Ok(window) => {
                self.window = Some(window);
                self.running.store(true, Ordering::SeqCst);
                Ok("Connected to Teams captions".to_string())
            }
            Err(e) => Err(anyhow::anyhow!(
                "Could not find Teams meeting window: {}",
                e
            )),
        }
    }

    pub fn get_next_caption(&mut self) -> Option<String> {
        if !self.running.load(Ordering::SeqCst) {
            return None;
        }

        let result = if let Some(ref window) = self.window {
            self.watcher.get_caption_text(window)
        } else {
            Err(anyhow::anyhow!("No window handle"))
        };

        match result {
            Ok(text) => {
                self.error_count = 0;
                if !text.is_empty() && text != self.last_text {
                    self.last_text = text.clone();
                    return Some(text);
                }
            }
            Err(e) => {
                self.error_count += 1;
                eprintln!(
                    "Warning: Failed to get Teams caption text (attempt {}/5): {}",
                    self.error_count, e
                );

                if self.error_count > 5 {
                    self.window = None;
                    self.running.store(false, Ordering::SeqCst);
                    return Some(format!("[ERROR] Lost connection to Teams: {}", e));
                }

                if let Ok(new_window) = self.watcher.find_teams_window_uia(self.selected_hwnd) {
                    self.window = Some(new_window);
                }
            }
        }
        None
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }

    pub fn poll_interval(&self) -> Duration {
        Duration::from_millis(100)
    }
}
