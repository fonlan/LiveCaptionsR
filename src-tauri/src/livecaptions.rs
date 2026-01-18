#![cfg(windows)]

use anyhow::{Context, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use std::process::Command;
use std::os::windows::process::CommandExt;
use windows::{
    core::*,
    Win32::Foundation::{HWND, RECT},
    Win32::System::Com::*,
    Win32::UI::Accessibility::*,
    Win32::UI::WindowsAndMessaging::*,
};

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Launch Windows LiveCaptions using PowerShell to simulate Win+Ctrl+L
pub fn launch_livecaptions() -> Result<()> {
    // Use PowerShell to send Win+Ctrl+L keystroke
    let _ = Command::new("powershell")
        .args([
            "-WindowStyle", "Hidden",
            "-Command",
            r#"
            Add-Type -TypeDefinition '
            using System;
            using System.Runtime.InteropServices;
            public class KeyboardSimulator {
                [DllImport("user32.dll")]
                public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
                
                public const byte VK_LWIN = 0x5B;
                public const byte VK_CONTROL = 0x11;
                public const byte VK_L = 0x4C;
                public const uint KEYEVENTF_KEYUP = 0x02;
                
                public static void SendWinCtrlL() {
                    keybd_event(VK_LWIN, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_L, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_L, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                    keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
            }
            '
            [KeyboardSimulator]::SendWinCtrlL()
            "#
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    
    // Wait for LiveCaptions to start
    std::thread::sleep(Duration::from_millis(2000));
    
    Ok(())
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

            Ok(Self { automation, original_rect: None })
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
                self.original_rect = Some(rect);
            }
            
            // Modify styles to hide from taskbar
            // Get current extended styles
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
            
            // Add TOOLWINDOW, remove APPWINDOW
            let new_ex_style = (ex_style | WS_EX_TOOLWINDOW.0 as isize) & !WS_EX_APPWINDOW.0 as isize;
            
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
            let new_ex_style = (ex_style & !WS_EX_TOOLWINDOW.0 as isize) | WS_EX_APPWINDOW.0 as isize;
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

            Ok(texts.join(" "))
        }
    }
}

pub struct CaptionStream {
    watcher: LiveCaptionsWatcher,
    window: Option<IUIAutomationElement>,
    running: Arc<AtomicBool>,
    last_text: String,
    window_hidden: bool,
}

impl CaptionStream {
    pub fn new() -> Result<Self> {
        let watcher = LiveCaptionsWatcher::new()?;
        Ok(Self {
            watcher,
            window: None,
            running: Arc::new(AtomicBool::new(false)),
            last_text: String::new(),
            window_hidden: false,
        })
    }

    pub fn connect(&mut self, hide_system_window: bool) -> Result<String> {
        match self.watcher.find_livecaptions_window() {
            Ok(window) => {
                if hide_system_window {
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

    pub fn get_next_caption(&mut self) -> Option<String> {
        if !self.running.load(Ordering::SeqCst) {
            return None;
        }

        if let Some(ref window) = self.window {
            match self.watcher.get_caption_text(window) {
                Ok(text) => {
                    if !text.is_empty() && text != self.last_text {
                        self.last_text = text.clone();
                        return Some(text);
                    }
                }
                Err(_) => {
                    self.restore_window();
                    self.window = None;
                    self.running.store(false, Ordering::SeqCst);
                    return Some("[ERROR] Lost connection to LiveCaptions".to_string());
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
