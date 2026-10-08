//! Independent account/ACL/WFP experiment. Never imported by production.
#![cfg(windows)]
mod native;
mod policy;

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [] => native::preflight(),
        [action] if action == "--run-owned-fixture" => native::run(),
        _ => Err("only preflight or --run-owned-fixture is supported; arbitrary paths and commands are rejected".into()),
    };
    if let Err(error) = result {
        eprintln!("stage A NO-GO: {error}");
        std::process::exit(2);
    }
}
