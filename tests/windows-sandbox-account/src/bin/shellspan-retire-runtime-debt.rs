fn main() {
    if std::env::args().len() != 1 {
        eprintln!("only the fixed first runtime recovery is supported");
        std::process::exit(2);
    }
    match shellspan_account_sandbox_prototype::powershell_runtime::retire_first_runtime_debt() {
        Ok(report) => println!("{}", report),
        Err(error) => {
            eprintln!("fixed runtime recovery failed: {error}");
            std::process::exit(2);
        }
    }
}
