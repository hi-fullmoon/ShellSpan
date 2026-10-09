//! Exact fixed RPC_UM account block inspection.
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::FWP_E_FILTER_NOT_FOUND;
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::*;
use windows_sys::Win32::Security::PSID;

/// Query exactly one journal key. Only FWP_E_FILTER_NOT_FOUND proves absence.
///
/// # Safety
/// `engine` must be a live WFP engine handle owned by the caller. `expected_sid`
/// must remain a valid complete SID allocation until this function returns.
pub unsafe fn inspect(
    engine: windows_sys::Win32::Foundation::HANDLE,
    key: &GUID,
    expected_sid: PSID,
) -> Result<bool, String> {
    if expected_sid.is_null() {
        return Err("RPC block query identity invalid".into());
    }
    let mut pointer = std::ptr::null_mut();
    let status = unsafe { FwpmFilterGetByKey0(engine, key, &mut pointer) };
    struct Allocation(*mut FWPM_FILTER0);
    impl Drop for Allocation {
        fn drop(&mut self) {
            if !self.0.is_null() {
                let mut pointer = self.0.cast();
                unsafe { FwpmFreeMemory0(&mut pointer) };
            }
        }
    }
    let _allocation = Allocation(pointer);
    if status == FWP_E_FILTER_NOT_FOUND as u32 {
        if !pointer.is_null() {
            return Err("absent RPC block returned an allocation".into());
        }
        return Ok(false);
    }
    if status != 0 {
        return Err(format!("inspect exact RPC block: Win32 {status}"));
    }
    let filter = unsafe { pointer.as_ref() }.ok_or("RPC block query returned null")?;
    unsafe { verify(filter, key, expected_sid) }?;
    Ok(true)
}

/// Change a single exact account RPC block, never a global rule.
/// Persist the intent before install; prove the owned tree stopped before retire.
///
/// # Safety
/// Engine, account SID and descriptor must be live caller-owned allocations.
/// Fixture and existing keys must come from the protected ownership receipt.
pub unsafe fn change_owned(
    engine: windows_sys::Win32::Foundation::HANDLE,
    intent: &crate::rpc_network_intent::RpcNetworkIntent,
    fixture: uuid::Uuid,
    existing_keys: &[uuid::Uuid],
    account: PSID,
    descriptor: &mut FWP_BYTE_BLOB,
    install: bool,
) -> Result<(), String> {
    unsafe { crate::wfp_account_descriptor::verify(descriptor, account) }?;
    let source = unsafe { crate::appcontainer_probe::sid_text(account) }?;
    intent.validate(fixture, &source, existing_keys)?;
    let key = GUID::from_u128(intent.filter_key.as_u128());
    let status = |code: u32, operation: &str| {
        if code == 0 {
            Ok(())
        } else {
            Err(format!("{operation}: Win32 {code}"))
        }
    };
    status(
        unsafe { FwpmTransactionBegin0(engine, 0) },
        "begin exact RPC block transaction",
    )?;
    struct Transaction {
        engine: windows_sys::Win32::Foundation::HANDLE,
        committed: bool,
    }
    impl Drop for Transaction {
        fn drop(&mut self) {
            if !self.committed {
                unsafe { FwpmTransactionAbort0(self.engine) };
            }
        }
    }
    let mut transaction = Transaction {
        engine,
        committed: false,
    };
    let present = unsafe { inspect(engine, &key, account) }?;
    if install {
        if present {
            return Err("RPC key already exists; do not replace or repeat installation".into());
        }
        let mut condition = FWPM_FILTER_CONDITION0 {
            fieldKey: FWPM_CONDITION_REMOTE_USER_TOKEN,
            matchType: FWP_MATCH_EQUAL,
            conditionValue: FWP_CONDITION_VALUE0 {
                r#type: FWP_SECURITY_DESCRIPTOR_TYPE,
                Anonymous: FWP_CONDITION_VALUE0_0 { sd: descriptor },
            },
        };
        let mut name: Vec<u16> = "ShellSpan phase A owned account RPC block"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let filter = FWPM_FILTER0 {
            filterKey: key,
            layerKey: FWPM_LAYER_RPC_UM,
            subLayerKey: FWPM_SUBLAYER_UNIVERSAL,
            flags: FWPM_FILTER_FLAG_PERSISTENT,
            displayData: FWPM_DISPLAY_DATA0 {
                name: name.as_mut_ptr(),
                description: std::ptr::null_mut(),
            },
            numFilterConditions: 1,
            filterCondition: &mut condition,
            action: FWPM_ACTION0 {
                r#type: FWP_ACTION_BLOCK,
                ..Default::default()
            },
            ..Default::default()
        };
        status(
            unsafe { FwpmFilterAdd0(engine, &filter, std::ptr::null_mut(), std::ptr::null_mut()) },
            "install exact account RPC block",
        )?;
    } else if present {
        status(
            unsafe { FwpmFilterDeleteByKey0(engine, &key) },
            "retire exact account RPC block",
        )?;
    }
    status(
        unsafe { FwpmTransactionCommit0(engine) },
        "commit exact RPC block transaction",
    )?;
    transaction.committed = true;
    if unsafe { inspect(engine, &key, account) }? != install {
        return Err(
            "RPC block final state unconfirmed; retain protected intent and account protection"
                .into(),
        );
    }
    Ok(())
}
fn same(left: &GUID, right: &GUID) -> bool {
    left.data1 == right.data1
        && left.data2 == right.data2
        && left.data3 == right.data3
        && left.data4 == right.data4
}
/// # Safety
/// Filter pointers must reference live WFP query allocations, and expected_sid
/// must reference a live complete owned-account SID allocation.
pub unsafe fn verify(filter: &FWPM_FILTER0, key: &GUID, expected_sid: PSID) -> Result<(), String> {
    if !same(&filter.filterKey, key)
        || !same(&filter.layerKey, &FWPM_LAYER_RPC_UM)
        || !same(&filter.subLayerKey, &FWPM_SUBLAYER_UNIVERSAL)
        || filter.flags & !FWPM_FILTER_FLAG_INDEXED != FWPM_FILTER_FLAG_PERSISTENT
        || filter.action.r#type != FWP_ACTION_BLOCK
        || filter.numFilterConditions != 1
        || filter.filterCondition.is_null()
    {
        return Err("RPC block key, layer, flags or action differs".into());
    }
    let condition = unsafe { &*filter.filterCondition };
    if !same(&condition.fieldKey, &FWPM_CONDITION_REMOTE_USER_TOKEN)
        || condition.matchType != FWP_MATCH_EQUAL
        || condition.conditionValue.r#type != FWP_SECURITY_DESCRIPTOR_TYPE
    {
        return Err("RPC block exact remote account condition differs".into());
    }
    let blob = unsafe { condition.conditionValue.Anonymous.sd.as_ref() }
        .ok_or("RPC block account descriptor missing")?;
    unsafe { crate::wfp_account_descriptor::verify(blob, expected_sid) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rpc_filter_rejects_connection_layers_wrong_condition_and_disabled_state() {
        let text: Vec<u16> = "D:(A;;CC;;;S-1-5-21-1-2-3-1001)"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut raw = std::ptr::null_mut();
        let mut size = 0;
        assert_ne!(
            unsafe {
                windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(),1,&mut raw,&mut size)
            },
            0
        );
        struct Local(*mut std::ffi::c_void);
        impl Drop for Local {
            fn drop(&mut self) {
                unsafe { windows_sys::Win32::Foundation::LocalFree(self.0) };
            }
        }
        let held = Local(raw);
        let mut blob = FWP_BYTE_BLOB {
            size,
            data: held.0.cast(),
        };
        let mut expected = [0x00000501u32, 0x05000000, 21, 1, 2, 3, 1001];
        let condition = FWPM_FILTER_CONDITION0 {
            fieldKey: FWPM_CONDITION_REMOTE_USER_TOKEN,
            matchType: FWP_MATCH_EQUAL,
            conditionValue: FWP_CONDITION_VALUE0 {
                r#type: FWP_SECURITY_DESCRIPTOR_TYPE,
                Anonymous: FWP_CONDITION_VALUE0_0 { sd: &mut blob },
            },
        };
        let key = GUID::from_u128(55);
        let mut filter = FWPM_FILTER0 {
            filterKey: key,
            layerKey: FWPM_LAYER_RPC_UM,
            subLayerKey: FWPM_SUBLAYER_UNIVERSAL,
            flags: FWPM_FILTER_FLAG_PERSISTENT,
            numFilterConditions: 1,
            action: FWPM_ACTION0 {
                r#type: FWP_ACTION_BLOCK,
                ..Default::default()
            },
            ..Default::default()
        };
        let check = |filter: &FWPM_FILTER0, condition: &FWPM_FILTER_CONDITION0| {
            let mut condition = *condition;
            let mut filter = *filter;
            filter.filterCondition = &mut condition;
            unsafe { verify(&filter, &key, expected.as_ptr().cast_mut().cast()) }
        };
        check(&filter, &condition).unwrap();
        filter.layerKey = FWPM_LAYER_ALE_AUTH_CONNECT_V4;
        assert!(check(&filter, &condition).is_err());
        filter.layerKey = FWPM_LAYER_RPC_UM;
        filter.flags |= FWPM_FILTER_FLAG_INDEXED;
        check(&filter, &condition).unwrap();
        filter.flags |= FWPM_FILTER_FLAG_DISABLED;
        assert!(check(&filter, &condition).is_err());
        filter.flags = FWPM_FILTER_FLAG_PERSISTENT;
        let mut changed = condition;
        changed.fieldKey = FWPM_CONDITION_ALE_USER_ID;
        assert!(check(&filter, &changed).is_err());
        changed = condition;
        changed.conditionValue.r#type = FWP_SID;
        assert!(check(&filter, &changed).is_err());
        changed = condition;
        changed.matchType = FWP_MATCH_NOT_EQUAL;
        assert!(check(&filter, &changed).is_err());
        // A well-formed rule cannot match another account.
        expected[6] = 1002;
        let mut condition = condition;
        filter.filterCondition = &mut condition;
        assert!(unsafe { verify(&filter, &key, expected.as_mut_ptr().cast()) }.is_err());
    }
}
