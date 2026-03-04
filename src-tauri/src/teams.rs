#![cfg(windows)]

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tracing::error;
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

// Note: runtime_id module kept for potential future use
mod runtime_id;

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
                if title_len > 0 {
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
        TRUE
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

    if let Some(meeting_window) = windows.iter().find(|w| {
        let title = w.title.to_lowercase();
        !title.contains("microsoft teams") && !title.starts_with("teams")
    }) {
        return Some(HWND(meeting_window.hwnd as *mut _));
    }

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

            let mut candidate = parent.clone();
            for _ in 0..6 {
                if let Ok(class_name) = candidate.CurrentClassName() {
                    let class_str = class_name.to_string();
                    if class_str.to_lowercase().starts_with("ui-box") {
                        return Ok(candidate);
                    }
                }

                if let Ok(next) = walker.GetParentElement(&candidate) {
                    candidate = next;
                } else {
                    break;
                }
            }

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

            Ok(parent)
        }
    }

    fn is_message_container_class(class_name: &str) -> bool {
        class_name.starts_with("fui-ChatMessage") || class_name.contains("ui-chat__message")
    }

    fn normalize_text_fragment(text: &str) -> String {
        text.replace('\r', " ")
            .replace('\n', " ")
            .split_whitespace()
            .collect::<Vec<&str>>()
            .join(" ")
            .trim()
            .to_string()
    }

    fn looks_like_speaker(value: &str) -> bool {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed.contains('\n') {
            return false;
        }

        if trimmed.chars().count() > 48 {
            return false;
        }

        if trimmed.split_whitespace().count() > 8 {
            return false;
        }

        !trimmed.chars().any(|c| {
            matches!(
                c,
                '.' | '!' | '?' | ';' | ':' | '。' | '！' | '？' | '；' | '：'
            )
        })
    }

    fn looks_like_content(value: &str) -> bool {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return false;
        }

        if trimmed.chars().count() > 48 || trimmed.contains('\n') {
            return true;
        }

        trimmed.chars().any(|c| {
            matches!(
                c,
                '.' | '!' | '?' | ',' | ';' | ':' | '。' | '！' | '？' | '，' | '；' | '：'
            )
        })
    }

    fn parse_message_parts(parts: &[String]) -> Option<(Option<String>, String)> {
        let normalized_parts: Vec<String> = parts
            .iter()
            .map(|part| Self::normalize_text_fragment(part))
            .filter(|part| !part.is_empty())
            .collect();

        if normalized_parts.is_empty() {
            return None;
        }

        if normalized_parts.len() == 1 {
            return Some((None, normalized_parts[0].clone()));
        }

        let first = &normalized_parts[0];
        let second = &normalized_parts[1];

        // Rarely, Teams surfaces content before speaker in a container.
        if !Self::looks_like_speaker(first)
            && Self::looks_like_speaker(second)
            && Self::looks_like_content(first)
        {
            let mut content_parts = vec![first.clone()];
            content_parts.extend(normalized_parts.iter().skip(2).cloned());
            let content = content_parts.join(" ").trim().to_string();
            if content.is_empty() {
                return None;
            }
            return Some((Some(second.clone()), content));
        }

        let content = normalized_parts
            .iter()
            .skip(1)
            .cloned()
            .collect::<Vec<String>>()
            .join(" ")
            .trim()
            .to_string();

        if content.is_empty() {
            return None;
        }

        Some((Some(first.clone()), content))
    }

    /// Get caption text from Teams window
    /// Returns ordered messages parsed per chat-message container.
    pub fn get_caption_text(
        &self,
        window: &IUIAutomationElement,
    ) -> Result<(Vec<(Option<String>, String)>, Option<IUIAutomationElement>)> {
        unsafe {
            let walker = match self.automation.ControlViewWalker() {
                Ok(w) => w,
                Err(e) => {
                    error!(error = %e, "Failed to get ControlViewWalker");
                    return Err(anyhow::anyhow!("Failed to get ControlViewWalker: {}", e));
                }
            };

            let text_condition = match self.automation.CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &VARIANT::from(UIA_TextControlTypeId.0 as i32),
            ) {
                Ok(c) => c,
                Err(e) => {
                    error!(error = %e, "Failed to create text condition");
                    return Err(anyhow::anyhow!("Failed to create text condition: {}", e));
                }
            };

            let elements = match window.FindAll(TreeScope_Descendants, &text_condition) {
                Ok(el) => el,
                Err(e) => {
                    error!(error = %e, "FindAll failed");
                    return Err(anyhow::anyhow!("Failed to find text elements: {}", e));
                }
            };

            let count = elements.Length().unwrap_or(0);
            const MAX_ELEMENTS: i32 = 5000;
            let limited_count = count.min(MAX_ELEMENTS);

            let mut container_texts: HashMap<String, Vec<String>> = HashMap::new();
            let mut container_order: Vec<String> = Vec::new();
            let mut first_container_element: Option<IUIAutomationElement> = None;

            for i in 0..limited_count {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let text_element = elements.GetElement(i).ok()?;

                    let text_content = text_element
                        .CurrentName()
                        .ok()
                        .map(|s| s.to_string())
                        .filter(|text| !text.trim().is_empty())
                        .or_else(|| {
                            let text_pattern_result: Result<
                                windows::Win32::UI::Accessibility::IUIAutomationTextPattern,
                                _,
                            > = text_element.GetCurrentPatternAs(
                                windows::Win32::UI::Accessibility::UIA_TextPatternId,
                            );

                            if let Ok(text_pattern) = text_pattern_result {
                                if let Ok(document_range) = text_pattern.DocumentRange() {
                                    document_range.GetText(-1).ok().map(|s| s.to_string())
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        })?;

                    let normalized_text = Self::normalize_text_fragment(&text_content);
                    if normalized_text.is_empty() {
                        return None;
                    }

                    let mut candidate = walker.GetParentElement(&text_element).ok()?;
                    let mut found_parent = None;

                    for _ in 0..6 {
                        let class_name = candidate
                            .CurrentClassName()
                            .ok()
                            .map(|s| s.to_string())
                            .unwrap_or_default();
                        if Self::is_message_container_class(&class_name) {
                            found_parent = Some(candidate.clone());
                            break;
                        }
                        candidate = walker.GetParentElement(&candidate).ok()?;
                    }

                    let parent = found_parent?;
                    if first_container_element.is_none() {
                        if let Ok(gp) = walker.GetParentElement(&parent) {
                            first_container_element = Some(gp);
                        } else {
                            first_container_element = Some(parent.clone());
                        }
                    }

                    let container_id = runtime_id::get_runtime_id_string(&parent);
                    Some((container_id, normalized_text))
                }));

                if let Ok(Some((container_id, text))) = result {
                    if !container_texts.contains_key(&container_id) {
                        container_order.push(container_id.clone());
                        container_texts.insert(container_id.clone(), Vec::new());
                    }

                    if let Some(bucket) = container_texts.get_mut(&container_id) {
                        let is_duplicate = bucket.last().map(|last| last == &text).unwrap_or(false);
                        if !is_duplicate {
                            bucket.push(text);
                        }
                    }
                }
            }

            let mut messages: Vec<(Option<String>, String)> = Vec::new();
            for container_id in container_order {
                if let Some(parts) = container_texts.remove(&container_id) {
                    if let Some((user, content)) = Self::parse_message_parts(&parts) {
                        messages.push((user, content));
                    }
                }
            }

            Ok((messages, first_container_element))
        }
    }

    pub fn find_teams_window_uia(
        &self,
        hwnd_override: Option<isize>,
    ) -> Result<IUIAutomationElement> {
        if let Some(hwnd_val) = hwnd_override {
            return self.get_element_from_handle(HWND(hwnd_val as *mut _));
        }
        if let Some(hwnd) = find_teams_webview_window() {
            return self.get_element_from_handle(hwnd);
        }
        Err(anyhow::anyhow!("Teams window not found."))
    }
}

pub struct TeamsCaptionStream {
    watcher: TeamsWatcher,
    window: Option<IUIAutomationElement>,
    caption_parent: Option<IUIAutomationElement>,
    selected_hwnd: Option<isize>,
    running: Arc<AtomicBool>,
    last_seen_signature: Option<String>,
    pending_messages: Vec<(Option<String>, String)>,
    recent_signatures: VecDeque<String>,
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
            last_seen_signature: None,
            pending_messages: Vec::new(),
            recent_signatures: VecDeque::with_capacity(120),
            error_count: 0,
        })
    }

    fn build_message_signature(user: Option<&str>, content: &str) -> String {
        let normalized_user = user.unwrap_or("").trim().to_lowercase();
        let normalized_content = content
            .to_lowercase()
            .replace('\r', " ")
            .replace('\n', " ")
            .split_whitespace()
            .collect::<Vec<&str>>()
            .join(" ")
            .trim_end_matches(|c: char| {
                matches!(
                    c,
                    '.' | '!' | '?' | ',' | ';' | ':' | '。' | '！' | '？' | '，' | '；' | '：'
                )
            })
            .to_string();

        format!("{}|{}", normalized_user, normalized_content)
    }

    fn push_if_new_message(&mut self, user: Option<String>, content: String) {
        let signature = Self::build_message_signature(user.as_deref(), &content);
        if signature.is_empty() || signature.ends_with('|') {
            return;
        }

        if self.recent_signatures.contains(&signature) {
            return;
        }

        self.recent_signatures.push_back(signature);
        if self.recent_signatures.len() > 120 {
            self.recent_signatures.pop_front();
        }

        self.pending_messages.push((user, content));
    }

    pub fn set_window(&mut self, hwnd: isize) {
        self.selected_hwnd = Some(hwnd);
    }

    pub fn connect(&mut self) -> Result<String> {
        self.error_count = 0;
        if !is_teams_running() {
            return Err(anyhow::anyhow!("Teams is not running."));
        }
        match self.watcher.find_teams_window_uia(self.selected_hwnd) {
            Ok(window) => {
                self.window = Some(window);
                self.running.store(true, Ordering::SeqCst);
                Ok("Connected to Teams captions".to_string())
            }
            Err(e) => Err(anyhow::anyhow!("Could not find Teams window: {}", e)),
        }
    }

    pub fn get_next_caption(&mut self) -> Option<(Option<String>, String)> {
        if !self.running.load(Ordering::SeqCst) {
            return None;
        }

        if !self.pending_messages.is_empty() {
            return Some(self.pending_messages.remove(0));
        }

        let window_ref = self.window.as_ref()?;
        let search_target = self.caption_parent.as_ref().unwrap_or(window_ref);
        let result = self.watcher.get_caption_text(search_target);

        match result {
            Ok((message_pairs, first_element)) => {
                self.error_count = 0;
                if !message_pairs.is_empty() && self.caption_parent.is_none() {
                    if let Some(element) = first_element {
                        if let Ok(container) = self.watcher.get_caption_container(&element) {
                            self.caption_parent = Some(container);
                        }
                    }
                }

                if message_pairs.is_empty() {
                    if self.caption_parent.is_some() {
                        self.caption_parent = None;
                    }
                    return None;
                }

                let signatures: Vec<String> = message_pairs
                    .iter()
                    .map(|(user, content)| Self::build_message_signature(user.as_deref(), content))
                    .collect();

                const RECOVERY_TAIL_PAIRS: usize = 3;
                let mut start_index = message_pairs.len().saturating_sub(1);

                if let Some(last_signature) = self.last_seen_signature.as_ref() {
                    if let Some(anchor_index) = signatures
                        .iter()
                        .rposition(|signature| signature == last_signature)
                    {
                        start_index = anchor_index.saturating_add(1);
                    } else {
                        // The caption list likely got recycled/reordered; only recover from a short tail.
                        start_index = message_pairs.len().saturating_sub(RECOVERY_TAIL_PAIRS);
                    }
                }

                for i in start_index..message_pairs.len() {
                    let (user, content) = &message_pairs[i];
                    self.push_if_new_message(user.clone(), content.clone());
                }

                self.last_seen_signature = signatures.last().cloned();

                if !self.pending_messages.is_empty() {
                    return Some(self.pending_messages.remove(0));
                }
            }
            Err(e) => {
                if self.caption_parent.is_some() {
                    self.caption_parent = None;
                }
                self.error_count += 1;
                if self.error_count > 5 {
                    self.running.store(false, Ordering::SeqCst);
                    return Some((None, format!("[ERROR] Lost connection: {}", e)));
                }
                match self.watcher.find_teams_window_uia(self.selected_hwnd) {
                    Ok(new_window) => self.window = Some(new_window),
                    Err(_) => {}
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
