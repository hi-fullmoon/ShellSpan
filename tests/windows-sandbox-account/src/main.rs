//! Independent account/ACL/WFP experiment. Never imported by production.
#![cfg(windows)]
mod native;
use shellspan_account_sandbox_prototype::fixture_runner as runner;
use shellspan_account_sandbox_prototype::policy;

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--owned-fixed-cross-slot-registry-access-probe"] {
        match shellspan_account_sandbox_prototype::cross_slot_registry_probe::access_report(false) {
            Ok(report) => {
                println!("{}", serde_json::to_string(&report).unwrap());
                std::process::exit(73);
            }
            Err(error) => {
                eprintln!("fixed cross-slot probe failed: {error}");
                std::process::exit(2);
            }
        }
    }

    if args == ["--owned-fixed-git-prefix-probe"] {
        match shellspan_account_sandbox_prototype::git_prefix_probe::child_report() {
            Ok(report) => {
                println!("{report}");
                std::process::exit(73);
            }
            Err(error) => {
                eprintln!("fixed Git prefix probe failed: {error}");
                std::process::exit(2);
            }
        }
    }
    if args == ["--owned-fixed-credential-control"] {
        match shellspan_account_sandbox_prototype::appcontainer_probe::ordinary_credential_child() {
            Ok(()) => std::process::exit(73),
            Err(error) => {
                eprintln!("fixed credential control failed: {error}");
                std::process::exit(2);
            }
        }
    }
    if args == ["--owned-fixed-leaf"] {
        match shellspan_account_sandbox_prototype::appcontainer_probe::leaf() {
            Ok(()) => std::process::exit(73),
            Err(error) => {
                eprintln!("fixed leaf failed: {error}");
                std::process::exit(2);
            }
        }
    }
    if args == ["--owned-fixed-probe"] {
        match shellspan_account_sandbox_prototype::appcontainer_probe::child() {
            Ok(()) => std::process::exit(73),
            Err(error) => {
                eprintln!("fixed workload failed: {error}");
                std::process::exit(2);
            }
        }
    }
    let result = match args.as_slice() {
        [] => native::preflight(),
        [action, id] if action == "--prepare-owned-system-profile-recovery" => native::prepare_system_profile_recovery(id),
        [action] if action == "--prepare-owned-system-admission" => native::prepare_system_admission(),
        [action] if action == "--prepare-owned-system-workload" => native::prepare_system_workload(),
        [action] if action == "--prepare-owned-system-powershell7-runtime" => native::prepare_system_powershell7_runtime(),
        [action] if action == "--prepare-owned-system-powershell7-artifact" => native::prepare_system_powershell7_artifact(),
        [action] if action == "--prepare-owned-system-git-bundle" => native::prepare_system_git_bundle(),
        [action] if action == "--prepare-owned-system-powershell7-build" => native::prepare_system_powershell7_build(),
        [action] if action == "--prepare-owned-system-git-init" => native::prepare_system_git_init(),
        [action] if action == "--prepare-owned-system-git-prefix-probe" => native::prepare_system_git_prefix_probe(),
        [action] if action == "--prepare-owned-system-cross-slot-registry-probe" => native::prepare_system_cross_slot_registry_probe(),
        [action] if action == "--prepare-owned-system-dns-package-block-internet-diagnostic" => native::prepare_system_dns_package_block_internet(),
        [action] if action == "--prepare-owned-system-dns-package-block" => native::prepare_system_dns_package_block(),
        [action] if action == "--prepare-owned-system-dns-rpc-block-internet-diagnostic" => native::prepare_system_dns_rpc_block_internet(),
        [action] if action == "--prepare-owned-system-dns-rpc-instrumentation-internet-diagnostic" => native::prepare_system_dns_rpc_instrumentation_internet(),
        [action] if action == "--prepare-owned-system-dns-rpc-instrumentation-default-diagnostic" => native::prepare_system_dns_rpc_instrumentation_default(),
        [action] if action == "--prepare-owned-system-node-rpc-block" => native::prepare_system_node_rpc_block(),
        [action] if action == "--prepare-owned-system-node-package-block" => native::prepare_system_node_package_block(),
        [action] if action == "--prepare-owned-system-node" => native::prepare_system_node(),
        [action] if action == "--prepare-owned-system-powershell" => native::prepare_system_powershell(),
        [action, mode] if action == "--prepare-owned-system-lifecycle" => native::prepare_system_lifecycle(mode),
        [action, id] if action == "--run-owned-system-admission" => native::run_system_admission(id),
        [action, id] if action == "--recover-owned-system-admission" => native::recover_system_admission(id),
        [action, id] if action == "--fixed-system-admission-service" => native::system_admission_entry(id),
        [action] if action == "--run-owned-fixture" => native::run(),
        [action] if action == "--diagnose-owned-journal" => native::diagnose_journal(),
        [action] if action == "--diagnose-owned-account-profile" => native::diagnose_account_profile(),
        [action] if action == "--diagnose-owned-account-lpac" => native::diagnose_account_lpac(),
        [action] if action == "--diagnose-owned-account-lpac-admission" => native::diagnose_account_lpac_admission(),
        [action] if action == "--diagnose-owned-controller-lpac-admission" => native::diagnose_controller_lpac_admission(),
        [action] if action == "--diagnose-owned-account-profile-crash" => native::interrupt_account_profile(),
        [action, id] if action == "--recover-owned-account-profile" => native::recover_account_profile(id),
        [action] if action == "--diagnose-loader-acl" => native::diagnose_loader_setup().map(|report| {
            println!("{}", report);
        }),
        [action, fixture_id] if action == "--recover-owned-fixture" => native::recover(fixture_id),
        _ => Err("only preflight, loader ACL diagnosis, owned fixture, or exact UUID recovery is supported; arbitrary paths and commands are rejected".into()),
    };
    if let Err(error) = result {
        eprintln!("stage A NO-GO: {error}");
        std::process::exit(2);
    }
}
