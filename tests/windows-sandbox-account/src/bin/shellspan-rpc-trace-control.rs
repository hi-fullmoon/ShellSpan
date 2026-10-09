//! Fixed ordinary self-PID diagnostic; no supplied PID, provider, endpoint or command.
fn main() {
    let result = (|| -> Result<serde_json::Value, String> {
        if std::env::args_os().len() != 1 {
            return Err("fixed RPC control accepts no arguments".into());
        }
        let fixture = uuid::Uuid::new_v4();
        let target = unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() };
        let identity = unsafe {
            shellspan_account_sandbox_prototype::rpc_trace_intent::ProcessIdentity::from_handle(
                target,
            )
        }?;
        let intent = shellspan_account_sandbox_prototype::rpc_trace_intent::RpcTraceIntent::new(
            fixture, identity,
        )?;
        let trace = unsafe {
            shellspan_account_sandbox_prototype::rpc_trace::RpcTrace::start_bound(&intent, target)
        }?;
        if shellspan_account_sandbox_prototype::rpc_trace::session_absent(fixture)? {
            return Err("owned RPC session absent while live".into());
        }
        let query =
            shellspan_account_sandbox_prototype::dns_native_probe::query_cache_only_sync(fixture);
        let observation = trace.finish()?;
        Ok(
            serde_json::json!({"fixture_id": fixture, "production": "unavailable",
            "scope": "ordinary elevated self-PID cache-only DNS control",
            "trace_intent": intent, "dns_query": query, "rpc_trace": observation}),
        )
    })();
    match result {
        Ok(report) => println!("{}", report),
        Err(error) => {
            eprintln!("fixed RPC trace control failed: {error}");
            std::process::exit(1);
        }
    }
}
