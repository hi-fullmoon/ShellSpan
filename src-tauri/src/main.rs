#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args = std::env::args_os().collect::<Vec<_>>();
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
