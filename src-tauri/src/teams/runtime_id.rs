use std::ffi::c_void;

use windows::Win32::System::{
    Com::SAFEARRAY,
    Ole::{
        SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound,
        SafeArrayUnaccessData,
    },
};
use windows::Win32::UI::Accessibility::IUIAutomationElement;

struct SafeArrayGuard(*mut SAFEARRAY);

impl Drop for SafeArrayGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = SafeArrayDestroy(self.0);
            }
        }
    }
}

fn format_runtime_id_parts(parts: &[i32]) -> String {
    parts
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(".")
}

unsafe fn read_runtime_id_parts(runtime_id: *mut SAFEARRAY) -> Option<Vec<i32>> {
    if runtime_id.is_null() {
        return None;
    }

    let runtime_id = SafeArrayGuard(runtime_id);
    let lower_bound = SafeArrayGetLBound(runtime_id.0, 1).ok()?;
    let upper_bound = SafeArrayGetUBound(runtime_id.0, 1).ok()?;
    let length = upper_bound.checked_sub(lower_bound)?.checked_add(1)?;
    if length <= 0 {
        return None;
    }

    let mut raw_data = std::ptr::null_mut::<c_void>();
    SafeArrayAccessData(runtime_id.0, &mut raw_data).ok()?;
    let parts = std::slice::from_raw_parts(raw_data.cast::<i32>(), length as usize).to_vec();
    let _ = SafeArrayUnaccessData(runtime_id.0);

    if parts.is_empty() {
        return None;
    }

    Some(parts)
}

// Helper to get a stable string ID for an element from its actual UIA RuntimeId.
pub unsafe fn get_runtime_id_string(element: &IUIAutomationElement) -> Option<String> {
    let runtime_id = element.GetRuntimeId().ok()?;
    let parts = read_runtime_id_parts(runtime_id)?;
    Some(format!("rid:{}", format_runtime_id_parts(&parts)))
}

#[cfg(test)]
mod tests {
    use super::format_runtime_id_parts;

    #[test]
    fn formats_runtime_id_parts_as_stable_string() {
        assert_eq!(format_runtime_id_parts(&[42, 7, 108]), "42.7.108");
    }
}
