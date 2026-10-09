//! No elevated setup, account creation or WFP control in this binary.
#![cfg(windows)]
use shellspan_account_sandbox_prototype::fixture_runner as runner;

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [action] if action == "--owned-bootstrap" || action == "--owned-network-child" => {
            runner::entry(action)
        }
        _ => Err("only fixed owned-fixture runner actions are accepted".into()),
    };
    if result.is_err() {
        std::process::exit(2);
    }
}
