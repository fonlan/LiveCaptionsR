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
    Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, TreeScope_Descendants,
        UIA_ControlTypePropertyId, UIA_ListItemControlTypeId, UIA_TextControlTypeId,
    },
    Win32::UI::WindowsAndMessaging::*,
};

mod runtime_id;
use runtime_id::get_runtime_id_string;

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
        Err(_) => {
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

/// Find all Teams-related PIDs (Main, WebView, Renderer) to ensure we find the window owner.
/// Hierarchy: ms-teams.exe → msedgewebview2.exe (direct child) → msedgewebview2.exe with --type=renderer
fn get_teams_related_pids() -> Vec<u32> {
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
        return Vec::new();
    }

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

    // Step 3: Find children of first-level webviews that have --type=renderer
    let mut renderer_pids: Vec<u32> = Vec::new();
    for &webview_pid in &first_level_webviews {
        if let Some(children) = parent_to_children.get(&webview_pid) {
            for &child_pid in children {
                if let Some(info) = pid_to_info.get(&child_pid) {
                    if info.name.to_lowercase() == "msedgewebview2.exe"
                        && info.cmdline.contains("--type=renderer")
                    {
                        renderer_pids.push(child_pid);
                    }
                }
            }
        }
    }

    // Combine all PIDs (Main Teams, Middleware WebViews, Renderers)
    // The meeting window might be owned by any of them in New Teams
    let mut all_pids = Vec::new();
    all_pids.extend(teams_pids);
    all_pids.extend(first_level_webviews);
    all_pids.extend(renderer_pids);

    all_pids
}

/// Find all windows belonging to the renderer processes
pub fn find_all_teams_windows() -> Vec<TeamsWindowInfo> {
    let target_pids_vec = get_teams_related_pids();
    if target_pids_vec.is_empty() {
        return Vec::new();
    }

    let target_pids: HashSet<u32> = target_pids_vec.into_iter().collect();

    struct EnumData {
        target_pids: HashSet<u32>,
        windows: Vec<TeamsWindowInfo>,
    }

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let data = &mut *(lparam.0 as *mut EnumData);

        let mut window_pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut window_pid));

        if data.target_pids.contains(&window_pid) {
            let visible = IsWindowVisible(hwnd).as_bool();
            let mut title = [0u16; 512];
            let title_len = GetWindowTextW(hwnd, &mut title);

            let title_str = if title_len > 0 {
                String::from_utf16_lossy(&title[..title_len as usize])
            } else {
                String::new()
            };

            if visible {
                // Only include windows with titles
                if title_len > 0 {
                    // Skip very small or empty titles
                    if !title_str.trim().is_empty() {
                        data.windows.push(TeamsWindowInfo {
                            hwnd: hwnd.0 as isize,
                            pid: window_pid,
                            title: title_str,
                        });
                    }
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

/// Find a single Teams window, returning the best match for a meeting window
pub fn find_teams_webview_window() -> Option<HWND> {
    let windows = find_all_teams_windows();
    if windows.is_empty() {
        return None;
    }

    // Priority 1: Windows that look like meeting windows (don't contain generic Teams branding)
    if let Some(meeting_window) = windows.iter().find(|w| {
        let title = w.title.to_lowercase();
        !title.contains("microsoft teams") 
        && !title.contains("microsoft teams") // Redundant but safe
        && !title.starts_with("teams")
    }) {
        return Some(HWND(meeting_window.hwnd as *mut _));
    }

    // Priority 2: Fallback to any window found
    if let Some(first) = windows.first() {
        return Some(HWND(first.hwnd as *mut _));
    }

    // Priority 2: Fallback to any window found
    if let Some(first) = windows.first() {
        return Some(HWND(first.hwnd as *mut _));
    }

    None
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

    pub fn get_caption_container(
        &self,
        text_element: &IUIAutomationElement,
    ) -> Result<IUIAutomationElement> {
        unsafe {
            let walker = self.automation.ControlViewWalker()?;
            let parent = walker.GetParentElement(text_element)?;

            // Strategy 1: Look for user-specified 'ui-box' container in ancestors
            let mut candidate = parent.clone();
            // Check up to 6 levels up for ui-box
            for _ in 0..6 {
                if let Ok(class_name) = candidate.CurrentClassName() {
                    let class_str = class_name.to_string();
                    // Check if class name starts with ui-box (case insensitive just in case)
                    if class_str.to_lowercase().starts_with("ui-box") {
                        eprintln!("[Teams] Locked onto 'ui-box' container: {}", class_str);
                        return Ok(candidate);
                    }
                }

                if let Ok(next) = walker.GetParentElement(&candidate) {
                    candidate = next;
                } else {
                    break;
                }
            }

            // Strategy 2: Fallback to Structure logic (ListItem -> List)
            let control_type = parent.CurrentControlType()?;
            if control_type
                == windows::Win32::UI::Accessibility::UIA_CONTROLTYPE_ID(
                    UIA_ListItemControlTypeId.0 as i32,
                )
            {
                if let Ok(grandparent) = walker.GetParentElement(&parent) {
                    return Ok(grandparent);
                }
            }

            // Strategy 3: Just return the direct parent
            Ok(parent)
        }
    }

    /// Get caption text from Teams window
    /// Revised strategy: Find all Text elements, then group them by their 'fui-ChatMessageCompact' parent.
    pub fn get_caption_text(
        &self,
        window: &IUIAutomationElement,
    ) -> Result<(Option<String>, String, Option<IUIAutomationElement>)> {
        unsafe {
            let walker = self.automation.ControlViewWalker()?;

            let text_condition = self
                .automation
                .CreatePropertyCondition(
                    UIA_ControlTypePropertyId,
                    &VARIANT::from(UIA_TextControlTypeId.0 as i32),
                )
                .context("Failed to create text condition")?;

            let start = std::time::Instant::now();
            let elements = window
                .FindAll(TreeScope_Descendants, &text_condition)
                .context("Failed to find text elements")?;
            let duration = start.elapsed();

            // Only log significant delays
            if duration.as_millis() > 100 {
                eprintln!(
                    "[Teams Performance] FindAll took {:?} for {} elements",
                    duration,
                    elements.Length().unwrap_or(0)
                );
            }

            let count = elements.Length().unwrap_or(0);

            // Vector of (ParentRuntimeIdString, Vec<String>)
            // We use RuntimeId string representation to group siblings
            let mut messages: Vec<(String, Vec<String>)> = Vec::new();
            let mut first_container_element: Option<IUIAutomationElement> = None;

            for i in 0..count {
                if let Ok(text_element) = elements.GetElement(i) {
                    // Get the text content
                    let text_content = if let Ok(name) = text_element.CurrentName() {
                        name.to_string()
                    } else {
                        continue;
                    };

                    if text_content.trim().is_empty() {
                        continue;
                    }

                    // Walk up to find the parent with ClassName starting with "fui-ChatMessageCompact"
                    if let Ok(parent) = walker.GetParentElement(&text_element) {
                        if let Ok(class_name) = parent.CurrentClassName() {
                            let class_str = class_name.to_string();
                            if class_str.starts_with("fui-ChatMessageCompact") {
                                // Found a valid message container!

                                // Capture the first valid container we find for future optimized scanning
                                if first_container_element.is_none() {
                                    // We might want the parent of this (the ui-box/list) for the stream's caption_parent
                                    // But storing this element is also useful as a hint
                                    if let Ok(grandparent) = walker.GetParentElement(&parent) {
                                        first_container_element = Some(grandparent);
                                    } else {
                                        first_container_element = Some(parent.clone());
                                    }
                                }

                                // Group by RuntimeId of the parent (fui-ChatMessageCompact)
                                // This ensures we group "User" and "Message" together
                                let runtime_id = if let Ok(_id_arr) = parent.GetRuntimeId() {
                                    Some(parent.clone())
                                } else {
                                    None
                                };

                                let mut added_to_last = false;
                                if let Some(ref _current_parent) = runtime_id {
                                    if let Some((last_parent_key, last_texts)) = messages.last_mut()
                                    {
                                        let current_id_str = get_runtime_id_string(&parent);
                                        if *last_parent_key == current_id_str {
                                            last_texts.push(text_content.clone());
                                            added_to_last = true;
                                        }
                                    }

                                    if !added_to_last {
                                        let current_id_str = get_runtime_id_string(&parent);
                                        messages.push((current_id_str, vec![text_content]));
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Format messages
            // We take the last few messages (e.g. last 3)
            let start_idx = if messages.len() > 3 {
                messages.len() - 3
            } else {
                0
            };
            let mut result_parts = Vec::new();
            let mut captured_user: Option<String> = None;

            for (_idx, (_current_id_str, texts)) in messages[start_idx..].iter().enumerate() {
                // Logic for "fui-ChatMessageCompact" container which holds multiple messages (a list)
                // The structure observed is [User, Content, User, Content, ...]
                // We want to extract only the Content parts (Odd indices)

                // Safety check: Ensure we have pairs
                if texts.len() >= 2 {
                    // Capture the username from the first pair if we haven't yet
                    if captured_user.is_none() {
                        captured_user = Some(texts[0].clone());
                    }

                    let mut group_contents = Vec::new();

                    for i in 0..texts.len() {
                        // Heuristic: Assume strict alternation User -> Content
                        // Take odd indices (1, 3, 5...)
                        if i % 2 == 1 {
                            group_contents.push(texts[i].clone());
                        }
                    }

                    if !group_contents.is_empty() {
                        result_parts.push(group_contents.join("  "));
                    }
                } else if texts.len() == 1 {
                    // Edge case: Just one element? Might be content only or user only.
                    // If it's short, might be ignored, but let's pass it for now.
                    result_parts.push(texts[0].clone());
                }
            }

            Ok((
                captured_user,
                result_parts.join("  "),
                first_container_element,
            ))
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
    caption_parent: Option<IUIAutomationElement>,
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
            caption_parent: None,
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

    pub fn get_next_caption(&mut self) -> Option<(Option<String>, String)> {
        if !self.running.load(Ordering::SeqCst) {
            return None;
        }

        let window_ref = if let Some(ref w) = self.window {
            w
        } else {
            return None;
        };

        // Use the cached parent if available, otherwise use the window
        let search_target = self.caption_parent.as_ref().unwrap_or(window_ref);

        let result = self.watcher.get_caption_text(search_target);

        match result {
            Ok((user, text, first_element)) => {
                self.error_count = 0;

                // If we found text but don't have a cached parent yet, try to find one
                if !text.is_empty() && self.caption_parent.is_none() {
                    if let Some(element) = first_element {
                        // Try to get the container of the text element
                        if let Ok(container) = self.watcher.get_caption_container(&element) {
                            eprintln!("[Teams] Found caption container candidate, switching to optimized scan mode.");
                            self.caption_parent = Some(container);
                        }
                    }
                }

                // If we used a cached parent but got no text, invalidate cache and retry immediately with full window
                if text.is_empty() && self.caption_parent.is_some() {
                    eprintln!("[Teams] Cached container yielded no text, invalidating cache.");
                    self.caption_parent = None;
                    // Recursive call with full window will happen next tick,
                    // or we could retry immediately? Let's return None and let next tick handle it to avoid infinite recursion risk
                    return None;
                }

                if !text.is_empty() && text != self.last_text {
                    self.last_text = text.clone();
                    return Some((user, text));
                }
            }
            Err(e) => {
                // If we failed with cached parent, invalidate it
                if self.caption_parent.is_some() {
                    self.caption_parent = None;
                    return None;
                }

                self.error_count += 1;
                eprintln!(
                    "Warning: Failed to get Teams caption text (attempt {}/5): {}",
                    self.error_count, e
                );

                if self.error_count > 5 {
                    self.window = None;
                    self.running.store(false, Ordering::SeqCst);
                    return Some((None, format!("[ERROR] Lost connection to Teams: {}", e)));
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
