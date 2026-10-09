//! Exact account match descriptors shared by ALE and RPC experiments.
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::FWP_BYTE_BLOB;
use windows_sys::Win32::Security::*;

/// # Safety
/// Blob data must be a live complete WFP-returned security descriptor allocation;
/// `expected` must be a live complete SID. This is not an untrusted-byte parser.
pub unsafe fn verify(blob: &FWP_BYTE_BLOB, expected: PSID) -> Result<(), String> {
    if blob.data.is_null()
        || blob.size == 0
        || blob.size > 65536
        || expected.is_null()
        || unsafe { IsValidSid(expected) } == 0
        || unsafe { IsValidSecurityDescriptor(blob.data.cast()) } == 0
        || unsafe { GetSecurityDescriptorLength(blob.data.cast()) } != blob.size
    {
        return Err("account match descriptor invalid or incomplete".into());
    }
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = std::ptr::null_mut();
    if unsafe {
        GetSecurityDescriptorDacl(blob.data.cast(), &mut present, &mut dacl, &mut defaulted)
    } == 0
        || present == 0
        || dacl.is_null()
        || unsafe { IsValidAcl(dacl) } == 0
        || unsafe { (*dacl).AceCount } != 1
    {
        return Err("account match requires one valid explicit ACE".into());
    }
    let mut entry = std::ptr::null_mut();
    if unsafe { GetAce(dacl, 0, &mut entry) } == 0 || entry.is_null() {
        return Err("account match ACE unavailable".into());
    }
    let header = unsafe { &*entry.cast::<ACE_HEADER>() };
    if header.AceType != 0 || header.AceFlags != 0 || header.AceSize < 12 {
        return Err("account match ACE type, flags or length differs".into());
    }
    let ace = unsafe { &*entry.cast::<ACCESS_ALLOWED_ACE>() };
    let actual = (&ace.SidStart as *const u32).cast_mut().cast();
    if ace.Mask != 1
        || unsafe { IsValidSid(actual) } == 0
        || u32::from(header.AceSize) != 8 + unsafe { GetLengthSid(actual) }
        || unsafe { EqualSid(actual, expected) } == 0
    {
        return Err("account match does not contain the exact owned SID and mask".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW,
    };
    struct Local(*mut std::ffi::c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            unsafe { windows_sys::Win32::Foundation::LocalFree(self.0) };
        }
    }
    #[test]
    fn actual_descriptors_reject_broad_inherited_duplicate_and_wrong_account_matches() {
        let source = "S-1-5-21-1-2-3-1001";
        let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let mut raw = std::ptr::null_mut();
        assert_ne!(
            unsafe { ConvertStringSidToSidW(wide(source).as_ptr(), &mut raw) },
            0
        );
        let expected = Local(raw);
        let inspect = |sddl: &str| {
            let mut raw = std::ptr::null_mut();
            let mut size = 0;
            assert_ne!(
                unsafe {
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        wide(sddl).as_ptr(),
                        1,
                        &mut raw,
                        &mut size,
                    )
                },
                0
            );
            let held = Local(raw);
            let blob = FWP_BYTE_BLOB {
                size,
                data: held.0.cast(),
            };
            let result = unsafe { verify(&blob, expected.0) };
            let truncated = FWP_BYTE_BLOB {
                size: size - 1,
                data: held.0.cast(),
            };
            assert!(unsafe { verify(&truncated, expected.0) }.is_err());
            result
        };
        inspect(&format!("D:(A;;CC;;;{source})")).unwrap();
        for sddl in [
            format!("D:(A;;GA;;;{source})"),
            format!("D:(A;OI;CC;;;{source})"),
            format!("D:(D;;CC;;;{source})"),
            format!("D:(A;;CC;;;{source})(A;;CC;;;WD)"),
            "D:(A;;CC;;;WD)".into(),
            "D:(A;;CC;;;S-1-5-21-1-2-3-1002)".into(),
            "D:".into(),
        ] {
            assert!(inspect(&sddl).is_err(), "{sddl}");
        }
    }
}
