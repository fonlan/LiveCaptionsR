#![cfg(windows)]

use anyhow::{Context, Result};
use std::collections::VecDeque;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use windows::{
    core::*,
    Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE},
    Win32::System::Com::*,
    Win32::UI::Accessibility::*,
    Win32::UI::WindowsAndMessaging::*,
};

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Helper function to check if a character is an end-of-sentence punctuation
fn is_eos_punctuation(text: &str, index: usize) -> bool {
    if index >= text.len() {
        return false;
    }
    let c = text.chars().nth(index).unwrap_or('\0');
    match c {
        '!' | '?' | '。' | '！' | '？' => true,
        '.' => {
            // Check if it's a decimal point
            if index > 0 && index < text.len() - 1 {
                let prev = text.chars().nth(index - 1).unwrap_or('\0');
                let next = text.chars().nth(index + 1).unwrap_or('\0');
                !(prev.is_ascii_digit() && next.is_ascii_digit())
            } else {
                true
            }
        }
        _ => false,
    }
}

/// Split text into complete sentences and return the trailing incomplete part
fn split_into_sentences(text: &str) -> (Vec<String>, String) {
    let mut sentences = Vec::new();
    let mut start = 0;
    let chars: Vec<char> = text.chars().collect();

    for i in 0..chars.len() {
        if is_eos_punctuation(text, i) {
            let sentence: String = chars[start..=i]
                .iter()
                .collect::<String>()
                .trim()
                .to_string();
            if !sentence.is_empty() {
                sentences.push(sentence);
            }
            start = i + 1;
        }
    }

    // Get the trailing incomplete sentence
    let trailing: String = if start < chars.len() {
        chars[start..].iter().collect::<String>().trim().to_string()
    } else {
        String::new()
    };

    (sentences, trailing)
}

// Global flag to signal when LiveCaptions window has been found (and optionally hidden)
static WINDOW_READY: OnceLock<std::sync::Mutex<bool>> = OnceLock::new();
static WINDOW_FOUND_BY_HOOK: AtomicBool = AtomicBool::new(false);
static FOUND_HWND: AtomicIsize = AtomicIsize::new(0);

/// Callback for EnumWindows to find and hide LiveCaptions window
unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let hide = lparam.0 != 0;
    let mut class_name = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut class_name);
    if len > 0 {
        let class = String::from_utf16_lossy(&class_name[..len as usize]);
        if class == "LiveCaptionsDesktopWindow" {
            if hide {
                // Found it! Move off-screen immediately
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOP,
                    -10000,
                    -10000,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
                );

                // Also set TOOLWINDOW style to hide from taskbar
                let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
                let new_ex_style =
                    (ex_style | WS_EX_TOOLWINDOW.0 as isize) & !WS_EX_APPWINDOW.0 as isize;
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex_style);
            }

            WINDOW_FOUND_BY_HOOK.store(true, Ordering::SeqCst);
            FOUND_HWND.store(hwnd.0 as isize, Ordering::SeqCst);

            // Signal that window is ready
            if let Some(mutex) = WINDOW_READY.get() {
                if let Ok(mut ready) = mutex.lock() {
                    *ready = true;
                }
            }

            return BOOL(0); // Stop enumeration
        }
    }
    TRUE // Continue enumeration
}

/// Aggressively poll for LiveCaptions window using EnumWindows
/// This is faster than UI Automation for initial detection
fn poll_livecaptions(hide: bool) {
    unsafe {
        let lparam = if hide { 1 } else { 0 };
        let _ = EnumWindows(Some(enum_windows_callback), LPARAM(lparam));
    }
}

/// Launch Windows LiveCaptions by directly starting the process.
/// Uses aggressive polling to hide the window as soon as it appears.
/// Returns Ok(hwnd) when window is ready and hidden, or Err after timeout.
pub fn launch_livecaptions(hide_system_window: bool) -> Result<isize> {
    // Initialize the ready flag
    let _ = WINDOW_READY.get_or_init(|| std::sync::Mutex::new(false));
    WINDOW_FOUND_BY_HOOK.store(false, Ordering::SeqCst);
    FOUND_HWND.store(0, Ordering::SeqCst);

    // Reset ready flag
    if let Some(mutex) = WINDOW_READY.get() {
        if let Ok(mut ready) = mutex.lock() {
            *ready = false;
        }
    }

    // Check if LiveCaptions is already running
    let already_running = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq LiveCaptions.exe", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("LiveCaptions.exe"))
        .unwrap_or(false);

    if already_running {
        // Already running, just find and hide it (if requested)
        poll_livecaptions(hide_system_window);
        let hwnd = FOUND_HWND.load(Ordering::SeqCst);
        if hwnd != 0 {
            return Ok(hwnd);
        }
    }

    // Start aggressive polling in a separate thread BEFORE launching
    // This minimizes the time between window creation and hiding
    let poll_handle = std::thread::spawn(move || {
        let start = Instant::now();
        let timeout = Duration::from_secs(30);

        while start.elapsed() < timeout {
            poll_livecaptions(hide_system_window);

            if WINDOW_FOUND_BY_HOOK.load(Ordering::SeqCst) {
                return true;
            }

            // Very fast polling - 10ms intervals
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    });

    if !already_running {
        // Launch LiveCaptions.exe
        Command::new("C:\\Windows\\System32\\LiveCaptions.exe")
            .spawn()
            .context(
                "Failed to launch LiveCaptions.exe. Please ensure LiveCaptions is installed.",
            )?;
    }

    // Wait for the polling thread to find and hide the window
    match poll_handle.join() {
        Ok(true) => {
            // Window found by EnumWindows.
            // Verify with UI Automation using ElementFromHandle (fast)
            let hwnd_val = FOUND_HWND.load(Ordering::SeqCst);
            if hwnd_val == 0 {
                return Err(anyhow::anyhow!("Window found but handle is 0"));
            }
            let hwnd = HWND(hwnd_val as *mut _);

            let start = Instant::now();
            let timeout = Duration::from_secs(10);
            let poll_interval = Duration::from_millis(100);

            let watcher = LiveCaptionsWatcher::new()?;

            while start.elapsed() < timeout {
                if watcher.get_element_from_handle(hwnd).is_ok() {
                    return Ok(hwnd_val);
                }
                std::thread::sleep(poll_interval);
            }

            // If we timed out on UIA but have HWND, return it anyway.
            // connect() will retry
            Ok(hwnd_val)
        }
        Ok(false) => Err(anyhow::anyhow!(
            "Timeout waiting for LiveCaptions to start (30s). \
            Please ensure LiveCaptions is installed and try again."
        )),
        Err(_) => Err(anyhow::anyhow!("Polling thread panicked")),
    }
}

/// Close Windows LiveCaptions
pub fn close_livecaptions() -> Result<()> {
    // Kill the LiveCaptions process
    let _ = Command::new("taskkill")
        .args(["/IM", "LiveCaptions.exe", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    Ok(())
}

pub struct LiveCaptionsWatcher {
    automation: IUIAutomation,
    original_rect: Option<RECT>,
}

impl LiveCaptionsWatcher {
    pub fn new() -> Result<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED).ok();

            let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
                .context("Failed to create IUIAutomation")?;

            Ok(Self {
                automation,
                original_rect: None,
            })
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

    pub fn find_livecaptions_window(&self) -> Result<IUIAutomationElement> {
        unsafe {
            let root = self
                .automation
                .GetRootElement()
                .context("Failed to get root element")?;

            let class_condition = self
                .automation
                .CreatePropertyCondition(
                    UIA_ClassNamePropertyId,
                    &VARIANT::from(BSTR::from("LiveCaptionsDesktopWindow")),
                )
                .context("Failed to create class condition")?;

            match root.FindFirst(TreeScope_Descendants, &class_condition) {
                Ok(element) => Ok(element),
                Err(_) => {
                    let name_condition = self
                        .automation
                        .CreatePropertyCondition(
                            UIA_NamePropertyId,
                            &VARIANT::from(BSTR::from("Live captions")),
                        )
                        .context("Failed to create name condition")?;

                    root.FindFirst(TreeScope_Descendants, &name_condition)
                        .context("LiveCaptions window not found")
                }
            }
        }
    }

    pub fn get_window_handle(&self, element: &IUIAutomationElement) -> Result<HWND> {
        unsafe {
            let handle = element
                .CurrentNativeWindowHandle()
                .context("Failed to get native window handle")?;
            Ok(HWND(handle.0))
        }
    }

    pub fn hide_window(&mut self, element: &IUIAutomationElement) -> Result<()> {
        let hwnd = self.get_window_handle(element)?;
        unsafe {
            // Save original position first
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                // Only save if it looks like a valid on-screen position (not already hidden)
                // We use -10000 for hiding, so checks against -5000 are safe
                if rect.left > -5000 && rect.top > -5000 {
                    self.original_rect = Some(rect);
                }
            }

            // Modify styles to hide from taskbar
            // Get current extended styles
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;

            // Add TOOLWINDOW, remove APPWINDOW
            let new_ex_style =
                (ex_style | WS_EX_TOOLWINDOW.0 as isize) & !WS_EX_APPWINDOW.0 as isize;

            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex_style);

            // Move window off-screen (to -10000, -10000) instead of hiding
            // This keeps UI Automation working while making window invisible
            let _ = SetWindowPos(
                hwnd,
                HWND_TOP,
                -10000,
                -10000,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        Ok(())
    }

    pub fn show_window(&mut self, element: &IUIAutomationElement) -> Result<()> {
        let hwnd = self.get_window_handle(element)?;
        unsafe {
            // Restore styles (remove TOOLWINDOW, add APPWINDOW back if it was there)
            // Ideally we should save the original style, but for now we just reverse the change
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
            let new_ex_style =
                (ex_style & !WS_EX_TOOLWINDOW.0 as isize) | WS_EX_APPWINDOW.0 as isize;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex_style);

            // Restore to original position
            if let Some(rect) = self.original_rect.take() {
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOP,
                    rect.left,
                    rect.top,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
            } else {
                // Fallback: just show at a reasonable position
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOP,
                    100,
                    100,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
        }
        Ok(())
    }

    pub fn get_caption_text(
        &self,
        window: &IUIAutomationElement,
    ) -> Result<(Option<String>, String)> {
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

            for i in 0..count {
                if let Ok(element) = elements.GetElement(i) {
                    if let Ok(name) = element.CurrentName() {
                        let text = name.to_string();
                        if !text.is_empty() && !text.contains("Live captions") {
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

            if texts.is_empty() {
                return Ok((None, String::new()));
            }

            if texts.len() > 1 {
                let user = texts[0].clone();
                let text = texts[1..].join(" ");
                Ok((Some(user), text))
            } else {
                Ok((None, texts[0].clone()))
            }
        }
    }

    // --- Automation Helpers ---

    fn find_element_by_id_and_pid(
        &self,
        root: &IUIAutomationElement,
        automation_id: &str,
        pid: i32,
    ) -> Result<IUIAutomationElement> {
        unsafe {
            let id_cond = self.automation.CreatePropertyCondition(
                UIA_AutomationIdPropertyId,
                &VARIANT::from(BSTR::from(automation_id)),
            )?;
            let pid_cond = self
                .automation
                .CreatePropertyCondition(UIA_ProcessIdPropertyId, &VARIANT::from(pid))?;
            let condition = self.automation.CreateAndCondition(&id_cond, &pid_cond)?;

            root.FindFirst(TreeScope_Descendants, &condition)
                .context(format!("Element {} (PID {}) not found", automation_id, pid))
        }
    }

    fn click_element(&self, element: &IUIAutomationElement) -> Result<()> {
        unsafe {
            // Priority 1: InvokePattern
            if let Ok(pattern) =
                element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            {
                pattern.Invoke().context("Invoke failed")?;
                return Ok(());
            }

            // Priority 2: TogglePattern
            if let Ok(pattern) =
                element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            {
                pattern.Toggle().context("Toggle failed")?;
                return Ok(());
            }

            // Priority 3: ExpandCollapsePattern
            if let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                UIA_ExpandCollapsePatternId,
            ) {
                let state = pattern.CurrentExpandCollapseState()?;
                if state == ExpandCollapseState_Collapsed {
                    pattern.Expand().context("Expand failed")?;
                }
                return Ok(());
            }

            // Priority 4: LegacyIAccessiblePattern (DoDefaultAction)
            if let Ok(pattern) = element
                .GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                    UIA_LegacyIAccessiblePatternId,
                )
            {
                pattern
                    .DoDefaultAction()
                    .context("Legacy DoDefaultAction failed")?;
                return Ok(());
            }

            // Priority 5: SelectionItemPattern
            if let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                UIA_SelectionItemPatternId,
            ) {
                pattern.Select().context("SelectionItem Select failed")?;
                return Ok(());
            }

            Err(anyhow::anyhow!("Element does not support click patterns (Invoke, Toggle, ExpandCollapse, LegacyIAccessible)"))
        }
    }

    pub fn configure_microphone(&self, window: &IUIAutomationElement, enable: bool) -> Result<()> {
        unsafe {
            let pid = window
                .CurrentProcessId()
                .context("Failed to get process ID")?;
            let root = self.automation.GetRootElement()?;

            // 1. Find and Click Settings Button (SettingsButton)
            // It is usually inside the main window
            let settings_btn = match self.find_element_by_id_and_pid(window, "SettingsButton", pid)
            {
                Ok(btn) => btn,
                Err(_) => {
                    // Fallback: search root if not found in window (unlikely but possible)
                    self.find_element_by_id_and_pid(&root, "SettingsButton", pid)?
                }
            };
            self.click_element(&settings_btn)
                .context("Failed to click SettingsButton")?;
            std::thread::sleep(Duration::from_millis(250));

            // 2. Find and Click Preferences Button (PreferencesButton)
            // Popups are usually top-level, so search root with PID
            let mut preferences_btn = None;
            for _ in 0..20 {
                // Increased retries
                if let Ok(btn) = self.find_element_by_id_and_pid(&root, "PreferencesButton", pid) {
                    preferences_btn = Some(btn);
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let preferences_btn = preferences_btn.context("PreferencesButton not found")?;
            self.click_element(&preferences_btn)
                .context("Failed to click PreferencesButton")?;
            std::thread::sleep(Duration::from_millis(250));

            // 3. Find Microphone Menu Item (MicrophoneMenuFlyoutItem)
            let mut mic_item = None;
            for _ in 0..20 {
                // Increased retries
                if let Ok(item) =
                    self.find_element_by_id_and_pid(&root, "MicrophoneMenuFlyoutItem", pid)
                {
                    mic_item = Some(item);
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let mic_item = mic_item.context("MicrophoneMenuFlyoutItem not found")?;

            // 4. Check and Toggle
            if let Ok(pattern) =
                mic_item.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            {
                let state = pattern.CurrentToggleState()?;
                let is_on = state == ToggleState_On;

                if is_on != enable {
                    // Need to toggle
                    if let Ok(invoke_pattern) = mic_item
                        .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    {
                        // Some menu items prefer Invoke over Toggle to change state
                        invoke_pattern.Invoke()?;
                    } else {
                        pattern.Toggle()?;
                    }
                }
            } else {
                // Fallback: If no toggle pattern, assume it behaves like a standard menu item and Invoke it?
                // But we don't know the state.
                // Let's try to infer state from Name? "Microphone audio included" vs "Include microphone audio"
                // Or "checked" state in LegacyIAccessible?
                if let Ok(legacy) = mic_item
                    .GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                        UIA_LegacyIAccessiblePatternId,
                    )
                {
                    let _state = legacy.CurrentState()?;
                    // STATE_SYSTEM_CHECKED = 0x10
                    // Windows crate const: STATE_SYSTEM_CHECKED
                    // But I need to check if that const is available or define it.
                    // For now, let's just log a warning if we can't determine state.
                    // The user implies it's a toggleable item.
                    eprintln!("Warning: MicrophoneMenuFlyoutItem does not support TogglePattern. Cannot determine current state safely.");
                } else {
                    eprintln!("Warning: MicrophoneMenuFlyoutItem does not support TogglePattern or LegacyIAccessible.");
                }
            }
        }
        Ok(())
    }
}

pub struct CaptionStream {
    watcher: LiveCaptionsWatcher,
    window: Option<IUIAutomationElement>,
    running: Arc<AtomicBool>,
    last_text: String,
    last_user: Option<String>,
    window_hidden: bool,
    error_count: u32,
    sent_sentences: VecDeque<String>,
}

impl CaptionStream {
    pub fn new() -> Result<Self> {
        let watcher = LiveCaptionsWatcher::new()?;
        Ok(Self {
            watcher,
            window: None,
            running: Arc::new(AtomicBool::new(false)),
            last_text: String::new(),
            last_user: None,
            window_hidden: false,
            error_count: 0,
            sent_sentences: VecDeque::with_capacity(20),
        })
    }

    pub fn configure_microphone(&self, enable: bool) -> Result<()> {
        if let Some(ref window) = self.window {
            self.watcher.configure_microphone(window, enable)?;
        }
        Ok(())
    }

    pub fn connect(
        &mut self,
        hide_system_window: bool,
        hwnd_override: Option<isize>,
    ) -> Result<String> {
        self.error_count = 0;
        let found_window = if let Some(hwnd_val) = hwnd_override {
            let hwnd = HWND(hwnd_val as *mut _);
            match self.watcher.get_element_from_handle(hwnd) {
                Ok(elem) => Ok(elem),
                Err(e) => {
                    eprintln!("Failed to get element from override HWND: {}", e);
                    self.watcher.find_livecaptions_window()
                }
            }
        } else {
            self.watcher.find_livecaptions_window()
        };

        match found_window {
            Ok(window) => {
                if hide_system_window {
                    // Window may already be hidden by launch_livecaptions(),
                    // but we call hide_window anyway to ensure this watcher
                    // captures the original_rect for proper restore on stop.
                    // hide_window is idempotent (moving off-screen twice is fine).
                    if let Err(e) = self.watcher.hide_window(&window) {
                        eprintln!("Warning: Failed to hide LiveCaptions window: {}", e);
                    } else {
                        self.window_hidden = true;
                    }
                }
                self.window = Some(window);
                self.running.store(true, Ordering::SeqCst);
                Ok("Connected to LiveCaptions".to_string())
            }
            Err(e) => Err(anyhow::anyhow!(
                "Please start Windows LiveCaptions (Win+Ctrl+L): {}",
                e
            )),
        }
    }

    pub fn get_next_caption(&mut self) -> Option<(Option<String>, String)> {
        if !self.running.load(Ordering::SeqCst) {
            return None;
        }

        // Use a separate scope to query text so we don't hold the borrow
        let result = if let Some(ref window) = self.window {
            self.watcher.get_caption_text(window)
        } else {
            // Should not happen if running is true
            Err(anyhow::anyhow!("No window handle"))
        };

        match result {
            Ok((user, text)) => {
                if !text.is_empty() {
                    // eprintln!("[LiveCaptions Raw] User: {:?}, Text: {}", user, text);
                }
                self.error_count = 0;

                // Clear sent sentences buffer if user changes, to avoid cross-user deduplication issues
                if user != self.last_user {
                    self.sent_sentences.clear();
                }

                if !text.is_empty() && (text != self.last_text || user != self.last_user) {
                    self.last_text = text.clone();
                    self.last_user = user.clone();

                    // Sentence-level deduplication for LiveCaptions
                    let (sentences, trailing) = split_into_sentences(&text);
                    let mut result_parts = Vec::new();

                    // Filter duplicate complete sentences
                    for sentence in sentences {
                        if !self.sent_sentences.contains(&sentence) {
                            result_parts.push(sentence.clone());
                            self.sent_sentences.push_back(sentence);

                            // Keep only the last 20 sentences
                            if self.sent_sentences.len() > 20 {
                                self.sent_sentences.pop_front();
                            }
                        }
                    }

                    // Always include the trailing incomplete part
                    if !trailing.is_empty() {
                        result_parts.push(trailing);
                    }

                    if !result_parts.is_empty() {
                        return Some((user, result_parts.join(" ")));
                    }
                }
            }
            Err(e) => {
                self.error_count += 1;
                eprintln!(
                    "Warning: Failed to get caption text (attempt {}/5): {}",
                    self.error_count, e
                );

                if self.error_count > 5 {
                    self.restore_window();
                    self.window = None;
                    self.running.store(false, Ordering::SeqCst);
                    return Some((
                        None,
                        format!("[ERROR] Lost connection to LiveCaptions: {}", e),
                    ));
                }

                // Try to recover by re-finding the window
                // This handles cases where the window handle became invalid (e.g. window moved/recreated)
                if let Ok(new_window) = self.watcher.find_livecaptions_window() {
                    // If we were hiding the window, make sure the new one is hidden too
                    if self.window_hidden {
                        let _ = self.watcher.hide_window(&new_window);
                    }
                    self.window = Some(new_window);
                }
            }
        }
        None
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn toggle_visibility(&mut self) -> bool {
        if let Some(ref window) = self.window {
            if self.window_hidden {
                if let Err(e) = self.watcher.show_window(window) {
                    eprintln!("Failed to show window: {}", e);
                } else {
                    self.window_hidden = false;
                }
            } else {
                if let Err(e) = self.watcher.hide_window(window) {
                    eprintln!("Failed to hide window: {}", e);
                } else {
                    self.window_hidden = true;
                }
            }
        }
        !self.window_hidden
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        self.restore_window();
    }

    fn restore_window(&mut self) {
        if self.window_hidden {
            if let Some(ref window) = self.window {
                let _ = self.watcher.show_window(window);
            }
            self.window_hidden = false;
        }
    }

    pub fn poll_interval(&self) -> Duration {
        Duration::from_millis(50)
    }
}

impl Drop for CaptionStream {
    fn drop(&mut self) {
        self.restore_window();
    }
}
