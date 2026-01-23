use windows::Win32::UI::Accessibility::IUIAutomationElement;

// Helper to get a stable string ID for an element (from its RuntimeId)
pub unsafe fn get_runtime_id_string(element: &IUIAutomationElement) -> String {
    if let Ok(id_sa) = element.GetRuntimeId() {
        // SafeArray handling is tricky in Rust windows crate raw pointers
        // But for unique ID comparison purposes, we can try to extract the ints
        // Or simpler: The raw pointer address of the SAFEARRAY data? No, that changes.
        // We need the content.

        // Let's implement a safe SAFEARRAY to Vec<i32> conversion
        // SAFEARRAY structure:
        // *SafeArrayGetDim(psa)
        // SafeArrayGetLBound, SafeArrayGetUBound
        // SafeArrayGetElement

        // Since we are in `unsafe` block and this is specific to `teams.rs` context:
        // NOTE: SAFEARRAY functions are in Win32::System::Ole
        use windows::Win32::System::Ole::{
            SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
        };

        // We must be careful not to leak or crash.
        // windows-rs usually wraps this well but GetRuntimeId returns *SAFEARRAY.
        // Actually it returns a Result containing a SafeArray wrapper or pointer.
        // The signature is `GetRuntimeId() -> Result<*mut SAFEARRAY>`.
        // Wait, in windows 0.58 it returns `Result<*mut SAFEARRAY>`.

        let psa = id_sa;
        if psa.is_null() {
            return "null".to_string();
        }

        let dim = SafeArrayGetDim(psa);
        if dim != 1 {
            return "invalid-dim".to_string();
        }

        let lbound: i32 = 0;
        let ubound: i32 = 0;
        let _ = SafeArrayGetLBound(psa, 1);
        let _ = SafeArrayGetUBound(psa, 1);

        let mut parts = Vec::new();
        for i in lbound..=ubound {
            let mut val: i32 = 0;
            // SafeArrayGetElement expects a pointer to the index and pointer to value
            // For 1D array, index is just the int.
            let idx = i;
            // Correction: SafeArrayGetElement takes *const i32 for indices
            let _ = SafeArrayGetElement(psa, &idx as *const i32, &mut val as *mut _ as *mut _);
            parts.push(val.to_string());
        }

        // Clean up? The SAFEARRAY returned by GetRuntimeId is owned by the caller usually?
        // In COM, [out, retval] implies transfer of ownership.
        // SafeArrayDestroy(psa); // We should destroy it if we own it.
        // IUIAutomation::GetRuntimeId gives us a new array.
        let _ = windows::Win32::System::Ole::SafeArrayDestroy(psa);

        return parts.join("-");
    }
    "unknown".to_string()
}
