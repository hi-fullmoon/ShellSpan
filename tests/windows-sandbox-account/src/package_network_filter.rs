//! Exact journal-bound package blocks for the independent experiment.
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::FWP_E_FILTER_NOT_FOUND;
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::*;
use windows_sys::Win32::Security::{EqualSid, IsValidSid, PSID};

/// Query exactly one journal key. Only FWP_E_FILTER_NOT_FOUND proves absence.
///
/// # Safety
/// `engine` must be a live WFP engine handle owned by the caller. `expected_sid`
/// must remain a valid complete SID allocation until this function returns.
pub unsafe fn inspect(
    engine: windows_sys::Win32::Foundation::HANDLE,
    key: &GUID,
    layer_index: usize,
    expected_sid: PSID,
) -> Result<bool, String> {
    if layer_index >= LAYERS.len() || expected_sid.is_null() {
        return Err("package block query identity invalid".into());
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
            return Err("absent package block returned an allocation".into());
        }
        return Ok(false);
    }
    if status != 0 {
        return Err(format!("inspect exact package block: Win32 {status}"));
    }
    let filter = unsafe { pointer.as_ref() }.ok_or("package block query returned null")?;
    unsafe { verify(filter, key, layer_index, expected_sid) }?;
    Ok(true)
}

/// Install or retire four fixed blocks in one transaction.
///
/// The protected intent must be published before installation. Before retirement,
/// the caller must prove the owned execution tree has stopped and retain account
/// SID blocks until this function and subsequent journal publication succeed.
///
/// # Safety
/// `engine` must be a live caller-owned WFP handle, and `package` a live SID.
/// The caller must supply fixture/account keys from the protected ownership record.
pub unsafe fn change_owned(
    engine: windows_sys::Win32::Foundation::HANDLE,
    intent: &crate::package_network_intent::PackageNetworkIntent,
    fixture: uuid::Uuid,
    account_keys: &[uuid::Uuid; 4],
    package: PSID,
    install: bool,
) -> Result<(), String> {
    if package.is_null() || unsafe { IsValidSid(package) } == 0 {
        return Err("package block transaction SID invalid".into());
    }
    let text = unsafe { crate::appcontainer_probe::sid_text(package) }?;
    intent.validate(fixture, &text, account_keys)?;
    let keys = intent.filter_keys.map(|key| GUID::from_u128(key.as_u128()));
    let check_status = |status: u32, operation: &str| {
        if status == 0 {
            Ok(())
        } else {
            Err(format!("{operation}: Win32 {status}"))
        }
    };
    check_status(
        unsafe { FwpmTransactionBegin0(engine, 0) },
        "begin package block transaction",
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
    let mut present = [false; 4];
    for (index, key) in keys.iter().enumerate() {
        present[index] = unsafe { inspect(engine, key, index, package) }?;
        if install && present[index] {
            return Err(
                "package block key already exists; do not replace or repeat installation".into(),
            );
        }
    }
    for (index, key) in keys.iter().enumerate() {
        if install {
            let mut condition = FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_ALE_PACKAGE_ID,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 {
                    r#type: FWP_SID,
                    Anonymous: FWP_CONDITION_VALUE0_0 {
                        sid: package.cast(),
                    },
                },
            };
            let mut name: Vec<u16> = "ShellSpan phase A owned package block"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let filter = FWPM_FILTER0 {
                filterKey: *key,
                flags: FWPM_FILTER_FLAG_PERSISTENT,
                displayData: FWPM_DISPLAY_DATA0 {
                    name: name.as_mut_ptr(),
                    description: std::ptr::null_mut(),
                },
                layerKey: LAYERS[index],
                subLayerKey: FWPM_SUBLAYER_UNIVERSAL,
                numFilterConditions: 1,
                filterCondition: &mut condition,
                action: FWPM_ACTION0 {
                    r#type: FWP_ACTION_BLOCK,
                    ..Default::default()
                },
                ..Default::default()
            };
            check_status(
                unsafe {
                    FwpmFilterAdd0(engine, &filter, std::ptr::null_mut(), std::ptr::null_mut())
                },
                "add exact package block",
            )?;
        } else if present[index] {
            check_status(
                unsafe { FwpmFilterDeleteByKey0(engine, key) },
                "retire exact package block",
            )?;
        }
    }
    check_status(
        unsafe { FwpmTransactionCommit0(engine) },
        "commit package block transaction",
    )?;
    transaction.committed = true;
    for (index, key) in keys.iter().enumerate() {
        if unsafe { inspect(engine, key, index, package) }? != install {
            return Err(
                "package block post-transaction state unconfirmed; retain protected intent".into(),
            );
        }
    }
    Ok(())
}
pub const LAYERS: [GUID; 4] = [
    FWPM_LAYER_ALE_AUTH_CONNECT_V4,
    FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
];
fn same(left: &GUID, right: &GUID) -> bool {
    left.data1 == right.data1
        && left.data2 == right.data2
        && left.data3 == right.data3
        && left.data4 == right.data4
}

/// Verify a filter returned by WFP against protected journal identity.
///
/// # Safety
/// All pointers in the filter must be live WFP-owned query memory, and the
/// expected SID must be a live allocation containing a valid complete SID.
pub unsafe fn verify(
    filter: &FWPM_FILTER0,
    key: &GUID,
    layer_index: usize,
    expected_sid: PSID,
) -> Result<(), String> {
    let layer = LAYERS
        .get(layer_index)
        .ok_or("package block layer index invalid")?;
    if !same(&filter.filterKey, key)
        || !same(&filter.layerKey, layer)
        || !same(&filter.subLayerKey, &FWPM_SUBLAYER_UNIVERSAL)
        || filter.flags & !FWPM_FILTER_FLAG_INDEXED != FWPM_FILTER_FLAG_PERSISTENT
        || filter.action.r#type != FWP_ACTION_BLOCK
        || filter.numFilterConditions != 1
        || filter.filterCondition.is_null()
    {
        return Err(format!("package block mismatch: key={}, layer={}, sublayer={}, flags={:#x}, action={:#x}, conditions={}", same(&filter.filterKey, key), same(&filter.layerKey, layer), same(&filter.subLayerKey, &FWPM_SUBLAYER_UNIVERSAL), filter.flags, filter.action.r#type, filter.numFilterConditions));
    }
    let condition = unsafe { &*filter.filterCondition };
    if !same(&condition.fieldKey, &FWPM_CONDITION_ALE_PACKAGE_ID)
        || condition.matchType != FWP_MATCH_EQUAL
        || condition.conditionValue.r#type != FWP_SID
    {
        return Err("package block condition differs".into());
    }
    let actual = unsafe { condition.conditionValue.Anonymous.sid };
    if actual.is_null()
        || expected_sid.is_null()
        || unsafe { IsValidSid(actual.cast()) } == 0
        || unsafe { IsValidSid(expected_sid) } == 0
        || unsafe { EqualSid(actual.cast(), expected_sid) } == 0
    {
        return Err("package block does not match exact owned SID".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_block_inspection_rejects_exact_identity_and_shape_mutations() {
        // Complete, aligned SID: S-1-15-2-1-2-3-4-5-6-7.
        let mut actual = [0x00000801u32, 0x0f000000, 2, 1, 2, 3, 4, 5, 6, 7];
        let mut expected = actual;
        let mut condition = FWPM_FILTER_CONDITION0 {
            fieldKey: FWPM_CONDITION_ALE_PACKAGE_ID,
            matchType: FWP_MATCH_EQUAL,
            conditionValue: FWP_CONDITION_VALUE0 {
                r#type: FWP_SID,
                Anonymous: FWP_CONDITION_VALUE0_0 {
                    sid: actual.as_mut_ptr().cast(),
                },
            },
        };
        let key = GUID::from_u128(42);
        let mut filter = FWPM_FILTER0 {
            filterKey: key,
            flags: FWPM_FILTER_FLAG_PERSISTENT,
            layerKey: LAYERS[0],
            subLayerKey: FWPM_SUBLAYER_UNIVERSAL,
            action: FWPM_ACTION0 {
                r#type: FWP_ACTION_BLOCK,
                ..Default::default()
            },
            numFilterConditions: 1,
            filterCondition: &mut condition,
            ..Default::default()
        };
        let check =
            |filter: &FWPM_FILTER0, condition: &FWPM_FILTER_CONDITION0, actual: &[u32; 10]| {
                let mut condition = *condition;
                condition.conditionValue.Anonymous.sid = actual.as_ptr().cast_mut().cast();
                let mut filter = *filter;
                filter.filterCondition = &mut condition;
                unsafe { verify(&filter, &key, 0, expected.as_ptr().cast_mut().cast()) }
            };
        check(&filter, &condition, &actual).unwrap();
        for layer in &LAYERS[1..] {
            filter.layerKey = *layer;
            assert!(check(&filter, &condition, &actual).is_err());
        }
        filter.layerKey = LAYERS[0];
        filter.filterKey = GUID::from_u128(43);
        assert!(check(&filter, &condition, &actual).is_err());
        filter.filterKey = key;
        filter.flags = 0;
        assert!(check(&filter, &condition, &actual).is_err());
        filter.flags = FWPM_FILTER_FLAG_PERSISTENT | FWPM_FILTER_FLAG_INDEXED;
        check(&filter, &condition, &actual).unwrap();
        filter.flags |= FWPM_FILTER_FLAG_DISABLED;
        assert!(check(&filter, &condition, &actual).is_err());
        filter.flags = FWPM_FILTER_FLAG_PERSISTENT;
        filter.action.r#type = FWP_ACTION_PERMIT;
        assert!(check(&filter, &condition, &actual).is_err());
        filter.action.r#type = FWP_ACTION_BLOCK;
        filter.numFilterConditions = 2;
        assert!(check(&filter, &condition, &actual).is_err());
        filter.numFilterConditions = 1;
        condition.fieldKey = FWPM_CONDITION_ALE_USER_ID;
        assert!(check(&filter, &condition, &actual).is_err());
        condition.fieldKey = FWPM_CONDITION_ALE_PACKAGE_ID;
        condition.matchType = FWP_MATCH_NOT_EQUAL;
        assert!(check(&filter, &condition, &actual).is_err());
        condition.matchType = FWP_MATCH_EQUAL;
        actual[9] = 8;
        assert!(check(&filter, &condition, &actual).is_err());
        actual[9] = 7;
        check(&filter, &condition, &actual).unwrap();
        assert!(unsafe { verify(&filter, &key, 4, expected.as_mut_ptr().cast()) }.is_err());
    }
}
