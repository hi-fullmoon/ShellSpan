//! Independent account/ACL/WFP experiment. Never imported by production.
#![cfg(windows)]
mod native;
use shellspan_account_sandbox_prototype::fixture_runner as runner;
use shellspan_account_sandbox_prototype::policy;

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--prepare-owned-system-frontend-project-materialization"]
        || args == ["--prepare-owned-system-frontend-project-workload-failure"]
    {
        let fail_workload = args == ["--prepare-owned-system-frontend-project-workload-failure"];
        if let Err(error) = native::prepare_system_frontend_project_materialization(fail_workload) {
            eprintln!("fixed project materialization preparation failed: {error}");
            std::process::exit(2);
        }
        return;
    }
    if args == ["--prepare-owned-system-frontend-source-workload-failure"] {
        if let Err(error) = native::prepare_system_frontend_source_workload_failure() {
            eprintln!("fixed source failure preparation failed: {error}");
            std::process::exit(2);
        }
        return;
    }
    if args == ["--prepare-owned-system-frontend-source-materialization"] {
        if let Err(error) = native::prepare_system_frontend_source_materialization() {
            eprintln!("fixed source materialization preparation failed: {error}");
            std::process::exit(2);
        }
        return;
    }
    if args == ["--prepare-owned-system-frontend-materialization"] {
        if let Err(error) = native::prepare_system_frontend_materialization() {
            eprintln!("fixed frontend materialization preparation failed: {error}");
            std::process::exit(2);
        }
        return;
    }
    if let [action, target] = args.as_slice() {
        if action == "--prepare-owned-system-frontend-project-materialization-recovery" {
            if let Err(error) =
                native::prepare_system_frontend_project_materialization_recovery(target)
            {
                eprintln!("fixed project recovery preparation failed: {error}");
                std::process::exit(2);
            }
            return;
        }
        if action == "--prepare-owned-system-frontend-source-materialization-recovery" {
            if let Err(error) =
                native::prepare_system_frontend_source_materialization_recovery(target)
            {
                eprintln!("fixed source recovery preparation failed: {error}");
                std::process::exit(2);
            }
            return;
        }
        if action == "--prepare-owned-system-frontend-materialization-recovery" {
            if let Err(error) = native::prepare_system_frontend_materialization_recovery(target) {
                eprintln!("fixed materialization recovery preparation failed: {error}");
                std::process::exit(2);
            }
            return;
        }
        if action == "--prepare-owned-system-frontend-journal-recovery" {
            if let Err(error) = native::prepare_system_frontend_journal_recovery(target) {
                eprintln!("fixed frontend recovery preparation failed: {error}");
                std::process::exit(2);
            }
            return;
        }
    }
    if args == ["--prepare-owned-system-frontend-journal"] {
        if let Err(error) = native::prepare_system_frontend_journal() {
            eprintln!("fixed frontend journal preparation failed: {error}");
            std::process::exit(2);
        }
        return;
    }
    if args == ["--inspect-fixed-frontend-runtime"]
        || args == ["--inspect-fixed-frontend-bundle-plan"]
    {
        match shellspan_account_sandbox_prototype::frontend_runtime_inventory::RuntimeInventory::inspect_fixed() {
            Ok(inventory) => {
                if args == ["--inspect-fixed-frontend-bundle-plan"] {
                    match inventory.bundle_plan() {
                        Ok(plan) => println!("{}", serde_json::json!({"inventory":inventory,"plan":plan})),
                        Err(error) => { eprintln!("fixed bundle plan failed: {error}"); std::process::exit(2); }
                    }
                } else { println!("{}", serde_json::to_string(&inventory).unwrap()); }
            }
            Err(error) => { eprintln!("fixed runtime inventory failed: {error}"); std::process::exit(2); }
        }
        return;
    }
    if args == ["--inspect-fixed-frontend-dependencies"] {
        match shellspan_account_sandbox_prototype::frontend_dependency_graph::DependencyGraph::inspect_fixed() {
            Ok(graph) => println!("{}", serde_json::to_string(&graph).unwrap()),
            Err(error) => {
                eprintln!("fixed frontend dependency inspection failed: {error}");
                std::process::exit(2);
            }
        }
        return;
    }
    if args == ["--inspect-fixed-frontend-source"] {
        match shellspan_account_sandbox_prototype::frontend_source_plan::FrozenFrontendSource::freeze() {
            Ok(source) => println!("{}", serde_json::to_string(source.manifest()).unwrap()),
            Err(error) => {
                eprintln!("fixed frontend source inspection failed: {error}");
                std::process::exit(2);
            }
        }
        return;
    }
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
                let _ = shellspan_account_sandbox_prototype::appcontainer_probe::record_fixed_child_error(&error);
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
        [action] if action == "--prepare-owned-system-git-metadata-init" => native::prepare_system_git_metadata_init(),
        [action] if action == "--prepare-owned-system-git-metadata-prefix" => native::prepare_system_git_metadata_prefix(),
        [action] if action == "--prepare-owned-system-git-metadata-partial-failure" => native::prepare_system_git_metadata_partial_failure(),
        [action] if action == "--prepare-owned-system-git-metadata-checkpoint-crash" => native::prepare_system_git_metadata_checkpoint_crash(),
        [action, id] if action == "--inspect-owned-ancestor-retirement" => native::inspect_ancestor_retirement(id),
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
        [action] if action == "--prepare-owned-system-node-project" => native::prepare_system_node_project(),
        [action] if action == "--prepare-owned-system-node-metadata-project" => native::prepare_system_node_metadata_project(),
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
