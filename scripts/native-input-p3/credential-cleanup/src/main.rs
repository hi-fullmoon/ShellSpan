//! Reads/deletes only an explicitly owned ai_save_routes reference. Never stores
//! or returns a password. Uses the same mature OS backend as the application.
#[cfg(windows)]
fn run() -> Result<(), &'static str> {
    use serde::Deserialize;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Receipt { version:u32, run_id:String, reference:String, service:String, created_by:String }
    let args:Vec<_>=std::env::args().collect();
    if args.len()!=3 || !["status","delete"].contains(&args[1].as_str()){return Err("INVALID_ARGUMENTS");}
    let data=std::fs::read(&args[2]).map_err(|_|"OWNERSHIP_RECEIPT_UNAVAILABLE")?;
    if data.len()>4096{return Err("OWNERSHIP_RECEIPT_LIMIT");}
    let receipt:Receipt=serde_json::from_slice(&data).map_err(|_|"INVALID_OWNERSHIP_RECEIPT")?;
    uuid::Uuid::parse_str(&receipt.run_id).map_err(|_|"INVALID_RUN_ID")?;
    let id=receipt.reference.strip_prefix("llm-").ok_or("INVALID_REFERENCE")?;
    let parsed=uuid::Uuid::parse_str(id).map_err(|_|"INVALID_REFERENCE")?;
    if receipt.version!=1 || receipt.reference!=format!("llm-{parsed}") || receipt.service!="com.shellspan.dev.ai-provider" || receipt.created_by!="ai_save_routes"{return Err("INVALID_OWNERSHIP_RECEIPT");}
    keyring_core::set_default_store(windows_native_keyring_store::Store::new().map_err(|_|"OS_STORE_UNAVAILABLE")?);
    let entry=keyring_core::Entry::new(&receipt.service,&receipt.reference).map_err(|_|"OS_ENTRY_UNAVAILABLE")?;
    let present=match entry.get_attributes(){Ok(attributes)=>{
        if attributes.get("target_name")!=Some(&format!("{}.{}",receipt.reference,receipt.service)){return Err("OS_TARGET_MISMATCH");}true
    },Err(keyring_core::Error::NoEntry)=>false,Err(_)=>return Err("OS_METADATA_UNAVAILABLE")};
    if args[1]=="delete"&&present{entry.delete_credential().map_err(|_|"OWNED_DELETE_FAILED")?;}
    let remaining=match entry.get_attributes(){Ok(_)=>true,Err(keyring_core::Error::NoEntry)=>false,Err(_)=>return Err("OS_ABSENCE_CHECK_FAILED")};
    println!("{}",serde_json::json!({"operation":args[1],"runId":receipt.run_id,"reference":receipt.reference,"presentBefore":present,"presentAfter":remaining,"secretRead":false}));
    if args[1]=="delete"&&remaining{return Err("OWNED_CREDENTIAL_REMAINS");}
    Ok(())
}
fn main(){
    #[cfg(windows)]
    if let Err(code)=run(){eprintln!("{code}");std::process::exit(1);}
    #[cfg(not(windows))]
    {eprintln!("ACTUAL_WINDOWS_REQUIRED");std::process::exit(2);}
}
