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
const REWRITE_MIN_TOKEN_COUNT: usize = 5;
const REWRITE_MAX_TOKEN_EDITS: usize = 2;
const REWRITE_STRONG_SIMILARITY: f32 = 0.72;
const REWRITE_EDGE_SIMILARITY: f32 = 0.58;
const REWRITE_LCS_RATIO_THRESHOLD: f32 = 0.70;
const REWRITE_MIN_SHARED_RUN_TOKENS: usize = 6;

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

    fn looks_like_speaker_word(value: &str) -> bool {
        let trimmed = value.trim_matches(|c: char| {
            matches!(
                c,
                '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | ',' | ':' | ';'
            )
        });

        if trimmed.is_empty() {
            return false;
        }

        let has_cased_letters = trimmed
            .chars()
            .any(|c| c.is_lowercase() || c.is_uppercase());
        if !has_cased_letters {
            return true;
        }

        let mut alphabetic = trimmed.chars().filter(|c| c.is_alphabetic());
        let Some(first_letter) = alphabetic.next() else {
            return true;
        };

        first_letter.is_uppercase() && alphabetic.all(|c| c.is_lowercase() || c.is_uppercase())
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

        if trimmed.chars().any(|c| {
            matches!(
                c,
                '.' | '!' | '?' | ';' | ':' | '。' | '！' | '？' | '；' | '：'
            )
        }) {
            return false;
        }

        let words: Vec<&str> = trimmed.split_whitespace().collect();
        if words.iter().all(|word| Self::looks_like_speaker_word(word)) {
            return true;
        }

        let has_cased_letters = trimmed
            .chars()
            .any(|c| c.is_lowercase() || c.is_uppercase());
        !has_cased_letters && words.len() <= 2 && trimmed.chars().count() <= 16
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
        }) || !Self::looks_like_speaker(trimmed)
    }

    fn push_message_pair(
        messages: &mut Vec<(Option<String>, String)>,
        user: Option<String>,
        content_parts: &mut Vec<String>,
    ) {
        let content = content_parts.join(" ").trim().to_string();
        if content.is_empty() {
            content_parts.clear();
            return;
        }

        messages.push((user, content));
        content_parts.clear();
    }

    fn strip_cumulative_prefix(previous_content: &str, current_content: &str) -> Option<String> {
        let previous = previous_content.trim();
        let current = current_content.trim();
        if previous.is_empty() || current.len() <= previous.len() {
            return None;
        }

        let suffix = current.strip_prefix(previous)?;
        let trimmed_suffix = suffix
            .trim_start_matches(|c: char| {
                c.is_whitespace()
                    || matches!(c, '-' | '–' | '—' | ':' | '：' | ',' | '，' | ';' | '；')
            })
            .trim();

        if trimmed_suffix.is_empty() {
            return None;
        }

        Some(trimmed_suffix.to_string())
    }

    fn decumulate_messages(
        messages: Vec<(Option<String>, String)>,
    ) -> Vec<(Option<String>, String)> {
        let mut decumulated: Vec<(Option<String>, String)> = Vec::with_capacity(messages.len());
        let mut previous_raw_content: Option<String> = None;

        for (user, raw_content) in messages {
            let normalized_content = Self::normalize_text_fragment(&raw_content);
            if normalized_content.is_empty() {
                continue;
            }

            let content = previous_raw_content
                .as_deref()
                .and_then(|previous| Self::strip_cumulative_prefix(previous, &normalized_content))
                .unwrap_or_else(|| normalized_content.clone());

            decumulated.push((user, content));
            previous_raw_content = Some(normalized_content);
        }

        decumulated
    }

    fn parse_message_parts(parts: &[String]) -> Vec<(Option<String>, String)> {
        let normalized_parts: Vec<String> = parts
            .iter()
            .map(|part| Self::normalize_text_fragment(part))
            .filter(|part| !part.is_empty())
            .collect();

        if normalized_parts.is_empty() {
            return Vec::new();
        }

        if normalized_parts.len() == 1 {
            return vec![(None, normalized_parts[0].clone())];
        }

        let mut raw_messages: Vec<(Option<String>, String)> = Vec::new();

        let first = &normalized_parts[0];
        let second = &normalized_parts[1];
        let mut index = 2;

        let (mut current_user, mut content_parts): (Option<String>, Vec<String>) =
            if !Self::looks_like_speaker(first) && Self::looks_like_speaker(second) {
                (Some(second.clone()), vec![first.clone()])
            } else {
                (Some(first.clone()), vec![second.clone()])
            };

        while index < normalized_parts.len() {
            let part = &normalized_parts[index];
            let next_part = normalized_parts.get(index + 1);
            let is_new_speaker_boundary = next_part
                .map(|next| Self::looks_like_speaker(part) && Self::looks_like_content(next))
                .unwrap_or(false);

            if is_new_speaker_boundary {
                Self::push_message_pair(&mut raw_messages, current_user.take(), &mut content_parts);
                current_user = Some(part.clone());
                content_parts.push(next_part.cloned().unwrap_or_default());
                index += 2;
                continue;
            }

            content_parts.push(part.clone());
            index += 1;
        }

        Self::push_message_pair(&mut raw_messages, current_user, &mut content_parts);
        Self::decumulate_messages(raw_messages)
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
                    messages.extend(Self::parse_message_parts(&parts));
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
    last_seen_message: Option<(Option<String>, String)>,
    pending_messages: Vec<(Option<String>, String)>,
    recent_signatures: VecDeque<String>,
    known_users: HashSet<String>,
    known_user_samples: Vec<String>,
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
            last_seen_message: None,
            pending_messages: Vec::new(),
            recent_signatures: VecDeque::with_capacity(120),
            known_users: HashSet::new(),
            known_user_samples: Vec::new(),
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

        if let Some((pending_user, pending_content)) = self.pending_messages.last_mut() {
            if Self::is_probable_rewrite(
                pending_user.as_deref(),
                pending_content,
                user.as_deref(),
                &content,
            ) {
                *pending_user = user.clone();
                *pending_content = content.clone();
                if !self.recent_signatures.contains(&signature) {
                    self.recent_signatures.push_back(signature);
                    if self.recent_signatures.len() > 120 {
                        self.recent_signatures.pop_front();
                    }
                }
                return;
            }
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

    fn normalize_for_match(value: &str) -> String {
        value
            .to_lowercase()
            .replace('\r', " ")
            .replace('\n', " ")
            .split_whitespace()
            .collect::<Vec<&str>>()
            .join(" ")
            .trim_matches(|c: char| {
                matches!(
                    c,
                    '.' | '!' | '?' | ',' | ';' | ':' | '。' | '！' | '？' | '，' | '；' | '：'
                )
            })
            .to_string()
    }

    fn tokenize_rewrite_text(value: &str) -> Vec<String> {
        let normalized = value
            .replace('\r', " ")
            .replace('\n', " ")
            .replace('’', "'")
            .to_lowercase();

        let mut tokens = Vec::new();
        let mut current = String::new();

        for ch in normalized.chars() {
            if ch.is_alphanumeric() {
                current.push(ch);
                continue;
            }

            if ch == '\'' && !current.is_empty() {
                current.push(ch);
                continue;
            }

            if current.ends_with('\'') {
                current.pop();
            }

            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        }

        if current.ends_with('\'') {
            current.pop();
        }

        if !current.is_empty() {
            tokens.push(current);
        }

        tokens
    }
    fn count_shared_token_prefix(left: &[String], right: &[String]) -> usize {
        let limit = left.len().min(right.len());
        let mut count = 0;
        while count < limit && left[count] == right[count] {
            count += 1;
        }
        count
    }
    fn count_shared_token_suffix(left: &[String], right: &[String]) -> usize {
        let limit = left.len().min(right.len());
        let mut count = 0;
        while count < limit && left[left.len() - 1 - count] == right[right.len() - 1 - count] {
            count += 1;
        }
        count
    }
    fn calculate_token_similarity(left: &[String], right: &[String]) -> f32 {
        if left == right {
            return 1.0;
        }

        let max_len = left.len().max(right.len());
        if max_len == 0 {
            return 0.0;
        }

        let mut matrix = vec![vec![0usize; right.len() + 1]; left.len() + 1];
        for (i, row) in matrix.iter_mut().enumerate().take(left.len() + 1) {
            row[0] = i;
        }
        for j in 0..=right.len() {
            matrix[0][j] = j;
        }

        for i in 1..=left.len() {
            for j in 1..=right.len() {
                let cost = usize::from(left[i - 1] != right[j - 1]);
                matrix[i][j] = (matrix[i - 1][j] + 1)
                    .min(matrix[i][j - 1] + 1)
                    .min(matrix[i - 1][j - 1] + cost);
            }
        }

        let distance = matrix[left.len()][right.len()];
        1.0 - distance as f32 / max_len as f32
    }
    fn calculate_lcs_length(left: &[String], right: &[String]) -> usize {
        if left.is_empty() || right.is_empty() {
            return 0;
        }

        let mut matrix = vec![vec![0usize; right.len() + 1]; left.len() + 1];
        for i in 1..=left.len() {
            for j in 1..=right.len() {
                matrix[i][j] = if left[i - 1] == right[j - 1] {
                    matrix[i - 1][j - 1] + 1
                } else {
                    matrix[i - 1][j].max(matrix[i][j - 1])
                };
            }
        }

        matrix[left.len()][right.len()]
    }
    fn calculate_longest_common_run_length(left: &[String], right: &[String]) -> usize {
        if left.is_empty() || right.is_empty() {
            return 0;
        }

        let mut matrix = vec![vec![0usize; right.len() + 1]; left.len() + 1];
        let mut best = 0usize;
        for i in 1..=left.len() {
            for j in 1..=right.len() {
                if left[i - 1] == right[j - 1] {
                    matrix[i][j] = matrix[i - 1][j - 1] + 1;
                    best = best.max(matrix[i][j]);
                }
            }
        }

        best
    }
    fn has_compatible_user(previous_user: Option<&str>, next_user: Option<&str>) -> bool {
        let previous = previous_user
            .map(Self::normalize_for_match)
            .unwrap_or_default();
        let next = next_user.map(Self::normalize_for_match).unwrap_or_default();

        previous.is_empty() || next.is_empty() || previous == next
    }
    fn is_probable_rewrite(
        previous_user: Option<&str>,
        previous_content: &str,
        next_user: Option<&str>,
        next_content: &str,
    ) -> bool {
        if !Self::has_compatible_user(previous_user, next_user) {
            return false;
        }

        let previous_tokens = Self::tokenize_rewrite_text(previous_content);
        let next_tokens = Self::tokenize_rewrite_text(next_content);
        let min_token_count = previous_tokens.len().min(next_tokens.len());
        if min_token_count == 0 {
            return false;
        }

        if previous_tokens == next_tokens {
            return true;
        }

        let previous_normalized = previous_tokens.join(" ");
        let next_normalized = next_tokens.join(" ");
        let shorter = if previous_normalized.len() <= next_normalized.len() {
            previous_normalized.as_str()
        } else {
            next_normalized.as_str()
        };
        let longer = if previous_normalized.len() > next_normalized.len() {
            previous_normalized.as_str()
        } else {
            next_normalized.as_str()
        };
        let has_containment = shorter.len() >= 8 && longer.contains(shorter);

        let shared_prefix_tokens = Self::count_shared_token_prefix(&previous_tokens, &next_tokens);
        let shared_suffix_tokens = Self::count_shared_token_suffix(&previous_tokens, &next_tokens);
        let shared_edge_tokens = min_token_count.min(shared_prefix_tokens + shared_suffix_tokens);
        let has_dominant_edge_coverage = min_token_count >= REWRITE_MIN_TOKEN_COUNT
            && shared_edge_tokens + REWRITE_MAX_TOKEN_EDITS >= min_token_count;
        let token_similarity = Self::calculate_token_similarity(&previous_tokens, &next_tokens);
        let lcs_length = Self::calculate_lcs_length(&previous_tokens, &next_tokens);
        let longest_shared_run =
            Self::calculate_longest_common_run_length(&previous_tokens, &next_tokens);
        let lcs_ratio_short = if min_token_count > 0 {
            lcs_length as f32 / min_token_count as f32
        } else {
            0.0
        };
        let has_strong_token_similarity = min_token_count >= REWRITE_MIN_TOKEN_COUNT
            && token_similarity >= REWRITE_STRONG_SIMILARITY;
        let has_edge_backed_similarity = min_token_count >= REWRITE_MIN_TOKEN_COUNT
            && token_similarity >= REWRITE_EDGE_SIMILARITY
            && (has_containment
                || has_dominant_edge_coverage
                || shared_prefix_tokens >= 3
                || shared_suffix_tokens >= 3);
        let has_strong_ordered_overlap = min_token_count >= REWRITE_MIN_TOKEN_COUNT
            && lcs_ratio_short >= REWRITE_LCS_RATIO_THRESHOLD
            && longest_shared_run >= REWRITE_MIN_SHARED_RUN_TOKENS;

        has_containment
            || has_dominant_edge_coverage
            || has_strong_token_similarity
            || has_edge_backed_similarity
            || has_strong_ordered_overlap
    }
    fn find_rewrite_anchor_index(
        &self,
        message_pairs: &[(Option<String>, String)],
        recovery_tail_pairs: usize,
    ) -> Option<usize> {
        let (previous_user, previous_content) = self.last_seen_message.as_ref()?;
        let start_index = message_pairs.len().saturating_sub(recovery_tail_pairs);

        (start_index..message_pairs.len()).rev().find(|&index| {
            let (next_user, next_content) = &message_pairs[index];
            Self::is_probable_rewrite(
                previous_user.as_deref(),
                previous_content,
                next_user.as_deref(),
                next_content,
            )
        })
    }
    fn remember_known_user(&mut self, user: &str) {
        let trimmed_user = user.trim();
        let normalized_user = Self::normalize_for_match(trimmed_user);
        if normalized_user.is_empty() {
            return;
        }

        self.known_users.insert(normalized_user);

        if !self.known_user_samples.iter().any(|sample| {
            Self::normalize_for_match(sample) == Self::normalize_for_match(trimmed_user)
        }) {
            self.known_user_samples.push(trimmed_user.to_string());
            if self.known_user_samples.len() > 32 {
                self.known_user_samples.remove(0);
            }
        }
    }

    fn push_unique_user_candidate(candidates: &mut Vec<String>, candidate: &str) {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            return;
        }

        if candidates.iter().any(|existing| {
            Self::normalize_for_match(existing) == Self::normalize_for_match(trimmed)
        }) {
            return;
        }

        candidates.push(trimmed.to_string());
    }

    fn collect_embedded_speaker_candidates(&self, user: Option<&str>) -> Vec<String> {
        let mut candidates = Vec::new();
        if let Some(current_user) = user {
            Self::push_unique_user_candidate(&mut candidates, current_user);
        }

        for sample in &self.known_user_samples {
            Self::push_unique_user_candidate(&mut candidates, sample);
        }

        candidates.sort_by(|left, right| {
            right
                .chars()
                .count()
                .cmp(&left.chars().count())
                .then_with(|| left.cmp(right))
        });
        candidates
    }

    fn trim_embedded_marker_suffix(value: &str) -> &str {
        value.trim_start_matches(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '-' | '–' | '—' | ':' | '：' | ',' | '，' | ';' | '；' | '(' | '[' | '{'
                )
        })
    }

    fn has_embedded_marker_boundary(content: &str, index: usize) -> bool {
        if index == 0 {
            return true;
        }

        content[..index]
            .chars()
            .rev()
            .find(|c| !c.is_whitespace())
            .map(|c| matches!(c, '.' | '!' | '?' | '。' | '！' | '？'))
            .unwrap_or(false)
    }

    fn find_embedded_speaker_marker(
        content: &str,
        candidates: &[String],
    ) -> Option<(usize, String, usize)> {
        let mut best_match: Option<(usize, String, usize)> = None;

        for candidate in candidates {
            for (index, _) in content.match_indices(candidate) {
                if !Self::has_embedded_marker_boundary(content, index) {
                    continue;
                }

                let suffix = Self::trim_embedded_marker_suffix(&content[index + candidate.len()..]);
                if suffix.is_empty() {
                    continue;
                }

                let candidate_match = (index, candidate.clone(), candidate.len());
                let should_replace = match &best_match {
                    None => true,
                    Some((best_index, best_candidate, _)) => {
                        index < *best_index
                            || (index == *best_index
                                && candidate.chars().count() > best_candidate.chars().count())
                    }
                };

                if should_replace {
                    best_match = Some(candidate_match);
                }
            }
        }

        best_match
    }

    fn split_message_by_embedded_speaker_markers(
        &self,
        user: Option<String>,
        content: String,
    ) -> Vec<(Option<String>, String)> {
        let normalized_content = TeamsWatcher::normalize_text_fragment(&content);
        if normalized_content.is_empty() {
            return Vec::new();
        }

        let candidates = self.collect_embedded_speaker_candidates(user.as_deref());
        if candidates.is_empty() {
            return vec![(user, normalized_content)];
        }

        let mut split_messages = Vec::new();
        let mut active_user = user;
        let mut remaining = normalized_content;

        while let Some((index, matched_user, matched_len)) =
            Self::find_embedded_speaker_marker(&remaining, &candidates)
        {
            let prefix = remaining[..index].trim();
            if !prefix.is_empty() {
                split_messages.push((active_user.clone(), prefix.to_string()));
            }

            active_user = Some(matched_user);
            remaining = Self::trim_embedded_marker_suffix(&remaining[index + matched_len..])
                .trim()
                .to_string();

            if remaining.is_empty() {
                break;
            }
        }

        if !remaining.is_empty() {
            split_messages.push((active_user, remaining));
        }

        split_messages
    }

    fn should_swap_user_content(&self, user: &str, content: &str) -> bool {
        let normalized_user = Self::normalize_for_match(user);
        let normalized_content = Self::normalize_for_match(content);

        if normalized_user.is_empty() || normalized_content.is_empty() {
            return false;
        }

        if self.known_users.contains(&normalized_user) {
            return false;
        }

        self.known_users.contains(&normalized_content)
    }

    pub fn set_window(&mut self, hwnd: isize) {
        self.selected_hwnd = Some(hwnd);
    }

    pub fn connect(&mut self) -> Result<String> {
        self.error_count = 0;
        self.last_seen_signature = None;
        self.last_seen_message = None;
        self.pending_messages.clear();
        self.recent_signatures.clear();
        self.known_users.clear();
        self.known_user_samples.clear();
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
            Ok((message_pairs_raw, first_element)) => {
                self.error_count = 0;
                if !message_pairs_raw.is_empty() && self.caption_parent.is_none() {
                    if let Some(element) = first_element {
                        if let Ok(container) = self.watcher.get_caption_container(&element) {
                            self.caption_parent = Some(container);
                        }
                    }
                }

                if message_pairs_raw.is_empty() {
                    if self.caption_parent.is_some() {
                        self.caption_parent = None;
                    }
                    return None;
                }

                let mut message_pairs: Vec<(Option<String>, String)> =
                    Vec::with_capacity(message_pairs_raw.len());
                for (mut user, mut content) in message_pairs_raw {
                    if let Some(current_user) = user.clone() {
                        if self.should_swap_user_content(&current_user, &content) {
                            let swapped_user = content.trim().to_string();
                            let swapped_content = current_user.trim().to_string();
                            if !swapped_user.is_empty() && !swapped_content.is_empty() {
                                user = Some(swapped_user);
                                content = swapped_content;
                            }
                        }
                    }

                    if content.trim().is_empty() {
                        continue;
                    }

                    for (split_user, split_content) in
                        self.split_message_by_embedded_speaker_markers(user.clone(), content)
                    {
                        if split_content.trim().is_empty() {
                            continue;
                        }

                        if let Some(current_user) = split_user.as_deref() {
                            self.remember_known_user(current_user);
                        }

                        message_pairs.push((split_user, split_content));
                    }
                }

                if message_pairs.is_empty() {
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
                    } else if let Some(anchor_index) =
                        self.find_rewrite_anchor_index(&message_pairs, RECOVERY_TAIL_PAIRS)
                    {
                        start_index = anchor_index;
                    } else {
                        start_index = message_pairs.len().saturating_sub(RECOVERY_TAIL_PAIRS);
                    }
                }

                for i in start_index..message_pairs.len() {
                    let (user, content) = &message_pairs[i];
                    self.push_if_new_message(user.clone(), content.clone());
                }

                self.last_seen_signature = signatures.last().cloned();
                self.last_seen_message = message_pairs.last().cloned();

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

#[cfg(test)]
mod tests {
    use super::TeamsCaptionStream;

    #[test]
    fn detects_swapped_pair_when_content_matches_known_user() {
        let mut stream = TeamsCaptionStream::new().expect("stream");
        stream.remember_known_user("Nikita Suprotivnyi (Nokia)");

        let should_swap = stream.should_swap_user_content(
            "In any case, and then kind of that's why what it means.",
            "Nikita Suprotivnyi (Nokia)",
        );

        assert!(should_swap);
    }

    #[test]
    fn keeps_normal_pair_when_user_is_known() {
        let mut stream = TeamsCaptionStream::new().expect("stream");
        stream.remember_known_user("Nikita Suprotivnyi (Nokia)");

        let should_swap = stream.should_swap_user_content(
            "Nikita Suprotivnyi (Nokia)",
            "The way people decide they want to use this for OK and if there's a need.",
        );

        assert!(!should_swap);
    }

    #[test]
    fn remembers_new_user_when_pair_is_accepted() {
        let mut stream = TeamsCaptionStream::new().expect("stream");

        assert!(!stream.should_swap_user_content("Alice Example", "Hello there"));
        stream.remember_known_user("Alice Example");

        assert!(stream
            .known_users
            .contains(&TeamsCaptionStream::normalize_for_match("Alice Example")));
    }

    #[test]
    fn splits_parts_when_later_speaker_appears() {
        let parts = vec![
            "Alice Example".to_string(),
            "First message from Alice.".to_string(),
            "Bob Example".to_string(),
            "Reply from Bob.".to_string(),
        ];

        let parsed = super::TeamsWatcher::parse_message_parts(&parts);

        assert_eq!(
            parsed,
            vec![
                (
                    Some("Alice Example".to_string()),
                    "First message from Alice.".to_string(),
                ),
                (
                    Some("Bob Example".to_string()),
                    "Reply from Bob.".to_string(),
                ),
            ]
        );
    }

    #[test]
    fn keeps_single_message_parts_together() {
        let parts = vec![
            "Alice Example".to_string(),
            "First chunk".to_string(),
            "second chunk".to_string(),
        ];

        let parsed = super::TeamsWatcher::parse_message_parts(&parts);

        assert_eq!(
            parsed,
            vec![(
                Some("Alice Example".to_string()),
                "First chunk second chunk".to_string(),
            )]
        );
    }

    #[test]
    fn supports_content_before_speaker_order() {
        let parts = vec!["Hello from Alice.".to_string(), "Alice Example".to_string()];

        let parsed = super::TeamsWatcher::parse_message_parts(&parts);

        assert_eq!(
            parsed,
            vec![(
                Some("Alice Example".to_string()),
                "Hello from Alice.".to_string(),
            )]
        );
    }

    #[test]
    fn strips_cumulative_prefix_from_later_speakers() {
        let parts = vec![
            "Alice Example".to_string(),
            "Hello".to_string(),
            "Bob Example".to_string(),
            "Hello Hi there".to_string(),
            "Carol Example".to_string(),
            "Hello Hi there Nice to meet you".to_string(),
        ];

        let parsed = super::TeamsWatcher::parse_message_parts(&parts);

        assert_eq!(
            parsed,
            vec![
                (Some("Alice Example".to_string()), "Hello".to_string()),
                (Some("Bob Example".to_string()), "Hi there".to_string()),
                (
                    Some("Carol Example".to_string()),
                    "Nice to meet you".to_string(),
                ),
            ]
        );
    }

    #[test]
    fn splits_repeated_same_speaker_cumulative_rows() {
        let parts = vec![
            "Alice Example".to_string(),
            "First chunk".to_string(),
            "Alice Example".to_string(),
            "First chunk second chunk".to_string(),
            "Alice Example".to_string(),
            "First chunk second chunk third chunk".to_string(),
        ];

        let parsed = super::TeamsWatcher::parse_message_parts(&parts);

        assert_eq!(
            parsed,
            vec![
                (Some("Alice Example".to_string()), "First chunk".to_string(),),
                (
                    Some("Alice Example".to_string()),
                    "second chunk".to_string(),
                ),
                (Some("Alice Example".to_string()), "third chunk".to_string(),),
            ]
        );
    }

    #[test]
    fn splits_embedded_same_speaker_marker_from_content() {
        let mut stream = TeamsCaptionStream::new().expect("stream");
        stream.remember_known_user("LingMin An (Nokia)");

        let parsed = stream.split_message_by_embedded_speaker_markers(
            Some("LingMin An (Nokia)".to_string()),
            "As the Dev OPS team send message in the chat, we can see that the add a projects use cases registration can be. LingMin An (Nokia) Closed".to_string(),
        );

        assert_eq!(
            parsed,
            vec![
                (
                    Some("LingMin An (Nokia)".to_string()),
                    "As the Dev OPS team send message in the chat, we can see that the add a projects use cases registration can be.".to_string(),
                ),
                (
                    Some("LingMin An (Nokia)".to_string()),
                    "Closed".to_string(),
                ),
            ]
        );
    }

    #[test]
    fn splits_embedded_known_next_speaker_marker_from_content() {
        let mut stream = TeamsCaptionStream::new().expect("stream");
        stream.remember_known_user("LingMin An (Nokia)");
        stream.remember_known_user("Bob Example");

        let parsed = stream.split_message_by_embedded_speaker_markers(
            Some("LingMin An (Nokia)".to_string()),
            "Closed. Bob Example Thanks everyone".to_string(),
        );

        assert_eq!(
            parsed,
            vec![
                (
                    Some("LingMin An (Nokia)".to_string()),
                    "Closed.".to_string(),
                ),
                (
                    Some("Bob Example".to_string()),
                    "Thanks everyone".to_string(),
                ),
            ]
        );
    }
    #[test]
    fn treats_same_speaker_caption_corrections_as_rewrites() {
        let is_rewrite = TeamsCaptionStream::is_probable_rewrite(
            Some("Alex Mercer (Contoso)"),
            "Review the rollout notes for the q3 migration because during the 118 planning workshop we still have an unresolved item around the service gateway and",
            Some("Alex Mercer (Contoso)"),
            "Review the rollout notes for the q3 migration. Because during the 118 planning workshop, we still have an unresolved item around the service gateway and deployment checklist.",
        );

        assert!(is_rewrite);
    }
    #[test]
    fn keeps_distinct_same_speaker_messages_out_of_rewrite_bucket() {
        let is_rewrite = TeamsCaptionStream::is_probable_rewrite(
            Some("Alex Mercer (Contoso)"),
            "Can everyone see the dashboard update from yesterday?",
            Some("Alex Mercer (Contoso)"),
            "Let's move on to the pipeline blockers for the next sprint.",
        );

        assert!(!is_rewrite);
    }
    #[test]
    fn finds_rewrite_anchor_inside_recovery_tail() {
        let mut stream = TeamsCaptionStream::new().expect("stream");
        stream.last_seen_message = Some((
            Some("Alex Mercer (Contoso)".to_string()),
            "Review the rollout notes for the q3 migration because during the 118 planning workshop we still have an unresolved item around the service gateway and".to_string(),
        ));

        let message_pairs = vec![
            (
                Some("Jordan Example".to_string()),
                "Unrelated earlier caption".to_string(),
            ),
            (
                Some("Alex Mercer (Contoso)".to_string()),
                "Review the rollout notes for the q3 migration. Because during the 118 planning workshop, we still have an unresolved item around the service gateway and deployment checklist."
                    .to_string(),
            ),
        ];

        let anchor_index = stream.find_rewrite_anchor_index(&message_pairs, 3);

        assert_eq!(anchor_index, Some(1));
    }
    #[test]
    fn treats_large_middle_overlap_rewrites_as_same_message() {
        let is_rewrite = TeamsCaptionStream::is_probable_rewrite(
            Some("Morgan Lee (Fabrikam)"),
            "You just mean it is a version inside the package image or some archive mirror yeah basically in the base image I think we just provide a script tools and a user to let them download those builds from the mirror what they want so because yeah",
            Some("Morgan Lee (Fabrikam)"),
            "It just means it is a version in the package image or the archive mirror yeah basically in the package image I think we just provide a scripts tools and the user to let them download the the builds from the mirror what they want",
        );

        assert!(is_rewrite);
    }
    #[test]
    fn treats_prefix_corrected_rewrites_with_long_ordered_overlap_as_same_message() {
        let is_rewrite = TeamsCaptionStream::is_probable_rewrite(
            Some("Casey Chen (Wingtip)"),
            "Taylor do you have a a suggestion for this I mean I do not know how platform team uses the tools so I am not sure they we are using the quite other version or not if if not we we can",
            Some("Casey Chen (Wingtip)"),
            "Tyler do you have a suggestion for this I mean I do not know how platform team uses the tools so I am not sure they were using the quite old version or not",
        );

        assert!(is_rewrite);
    }
}
