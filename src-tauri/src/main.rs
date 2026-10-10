#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args = std::env::args_os().collect::<Vec<_>>();
    if args.get(1).is_some_and(|arg| arg == "--native-host-check") {
        if args.len() != 5 {
            eprintln!("Usage: ShellSpan --native-host-check <owned-directory> <existing-profile-name> <lifecycle|crash|recover|handshake>");
            std::process::exit(2);
        }
        #[cfg(all(target_os = "macos", debug_assertions))]
        {
            let result = args[3]
                .to_str()
                .zip(args[4].to_str())
                .ok_or("Host check arguments invalid".to_owned())
                .and_then(|(profile, mode)| {
                    shell_span_lib::run_native_host_check(
                        std::path::Path::new(&args[2]),
                        profile,
                        mode,
                    )
                });
            if result.is_err() {
                eprintln!("Host check did not pass; preserve owned evidence and resources");
                std::process::exit(1);
            }
        }
        #[cfg(not(all(target_os = "macos", debug_assertions)))]
        std::process::exit(2);
        return;
    }
    if args
        .get(1)
        .is_some_and(|arg| arg == "--local-resource-controller")
    {
        #[cfg(target_os = "macos")]
        {
            if args.len() != 2 || shell_span_lib::run_local_resource_controller().is_err() {
                std::process::exit(2);
            }
            return;
        }
        #[cfg(not(target_os = "macos"))]
        std::process::exit(2);
    }
    if args
        .get(1)
        .is_some_and(|arg| arg == "--native-sandbox-settings-check")
    {
        if !(3..=4).contains(&args.len()) || args.get(3).is_some_and(|arg| arg != "root-entry") {
            eprintln!("Usage: ShellSpan --native-sandbox-settings-check <empty-fixture-directory> [root-entry]");
            std::process::exit(2);
        }
        #[cfg(all(target_os = "macos", debug_assertions))]
        if let Err(error) = shell_span_lib::run_native_sandbox_settings_check(
            std::path::Path::new(&args[2]),
            args.get(3).is_some_and(|arg| arg == "root-entry"),
        ) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        #[cfg(not(all(target_os = "macos", debug_assertions)))]
        {
            eprintln!("Native sandbox settings checks require a macOS debug build");
            std::process::exit(2);
        }
        return;
    }
    if args
        .get(1)
        .is_some_and(|arg| arg == "--native-remote-check")
    {
        if args.len() != 3 {
            eprintln!("Usage: ShellSpan --native-remote-check <empty-fixture-directory>");
            std::process::exit(2);
        }
        #[cfg(all(target_os = "macos", debug_assertions))]
        if let Err(error) = shell_span_lib::run_native_remote_check(std::path::Path::new(&args[2]))
        {
            eprintln!("{error}");
            std::process::exit(1);
        }
        #[cfg(not(all(target_os = "macos", debug_assertions)))]
        {
            eprintln!("Native remote checks require a macOS debug build");
            std::process::exit(2);
        }
        return;
    }
    if args.get(1).is_some_and(|arg| arg == "--native-agent-check") {
        if !(3..=4).contains(&args.len())
            || args.get(3).is_some_and(|arg| {
                arg != "normal"
                    && arg != "cancel"
                    && arg != "session-reads"
                    && arg != "network"
                    && arg != "cache-writes"
            })
        {
            eprintln!(
                "Usage: ShellSpan --native-agent-check <empty-fixture-directory> [normal|cancel|session-reads|network|cache-writes]"
            );
            std::process::exit(2);
        }
        #[cfg(all(target_os = "macos", debug_assertions))]
        if let Err(error) = shell_span_lib::run_native_agent_check(
            std::path::Path::new(&args[2]),
            args.get(3).is_some_and(|arg| arg == "cancel"),
            args.get(3)
                .is_some_and(|arg| arg == "session-reads" || arg == "cache-writes"),
            args.get(3).is_some_and(|arg| arg == "network"),
            args.get(3).is_some_and(|arg| arg == "cache-writes"),
        ) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        #[cfg(not(all(target_os = "macos", debug_assertions)))]
        {
            eprintln!("Native model checks require a macOS debug build");
            std::process::exit(2);
        }
        return;
    }
    if args
        .get(1)
        .is_some_and(|arg| arg == "--native-sandbox-check")
    {
        if args.len() != 4 {
            eprintln!("Usage: ShellSpan --native-sandbox-check <workspace> <command>");
            std::process::exit(2);
        }
        #[cfg(all(target_os = "macos", debug_assertions))]
        match shell_span_lib::run_native_sandbox_check(
            std::path::Path::new(&args[2]),
            &args[3].to_string_lossy(),
        ) {
            Ok(result) => {
                println!("{result}");
                if result["result"]["exitCode"] != 0 {
                    std::process::exit(1);
                }
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        #[cfg(not(all(target_os = "macos", debug_assertions)))]
        {
            eprintln!("Native sandbox checks require a macOS debug build");
            std::process::exit(2);
        }
        return;
    }
    if args
        .get(1)
        .is_some_and(|arg| arg == "--gui-lifecycle-check")
    {
        if args.len() != 4 {
            eprintln!("Usage: ShellSpan --gui-lifecycle-check <fixture-root> <quit|restart|quit-active|restart-active|quit-debt|status>");
            std::process::exit(2);
        }
        #[cfg(debug_assertions)]
        if let Err(error) = shell_span_lib::run_gui_lifecycle_check(
            std::path::Path::new(&args[2]),
            &args[3].to_string_lossy(),
        ) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        #[cfg(not(debug_assertions))]
        {
            eprintln!("GUI lifecycle checks require a debug build");
            std::process::exit(2);
        }
        return;
    }
    if args.get(1).is_some_and(|arg| arg == "--check-deployment") {
        if args.len() != 4 {
            eprintln!("Usage: ShellSpan --check-deployment <database> <application-id>");
            std::process::exit(2);
        }
        match shell_span_lib::check_deployment_configuration(
            std::path::Path::new(&args[2]),
            &args[3].to_string_lossy(),
        ) {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if args.get(1).is_some_and(|arg| arg == "--import-deployment") {
        if args.len() != 4 {
            eprintln!("Usage: ShellSpan --import-deployment <database> <configuration.json>");
            std::process::exit(2);
        }
        match shell_span_lib::import_deployment_configuration(
            std::path::Path::new(&args[2]),
            std::path::Path::new(&args[3]),
        ) {
            Ok(entry) => println!("{entry}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    shell_span_lib::run();
}
