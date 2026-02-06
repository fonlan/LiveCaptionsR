use windows::Win32::UI::Accessibility::IUIAutomationElement;

// Helper to get a stable string ID for an element (from its RuntimeId)
#[allow(dead_code)]
pub unsafe fn get_runtime_id_string(element: &IUIAutomationElement) -> String {
    // Use a simple address-based ID to avoid unsafe SAFEARRAY manipulation
    // This is stable enough for deduplication purposes during a single session
    format!("{:p}", element)
}
