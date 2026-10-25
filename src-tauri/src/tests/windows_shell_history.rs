//! Native Windows test shells retain normal PSReadLine behavior in private history.
use portable_pty::CommandBuilder;

pub(crate) struct WindowsShellHistory {
    root: tempfile::TempDir,
}

impl WindowsShellHistory {
    pub(crate) fn configure(command: &mut CommandBuilder) -> Self {
        let root = tempfile::tempdir().unwrap();
        let history = root.path().join("history.txt");
        let report = root.path().join("actual-history-path.txt");
        let history_literal = history.to_string_lossy().replace('\'', "''");
        let report_literal = report.to_string_lossy().replace('\'', "''");
        let startup = format!(
            "try {{ Import-Module PSReadLine -ErrorAction Stop; PSReadLine\\Set-PSReadLineOption -HistorySavePath '{history_literal}' -ErrorAction Stop; $p=(PSReadLine\\Get-PSReadLineOption).HistorySavePath; if ($p -cne '{history_literal}') {{ exit 125 }}; [IO.File]::WriteAllText('{report_literal}',$p) }} catch {{ exit 125 }}"
        );
        command.args(["-NoLogo", "-NoProfile", "-NoExit", "-Command", &startup]);
        Self { root }
    }

    pub(crate) fn verify(&self, label: &str, retain_test_commands: bool) {
        let history = self.root.path().join("history.txt");
        assert_eq!(
            std::fs::read_to_string(self.root.path().join("actual-history-path.txt")).unwrap(),
            history.to_string_lossy(),
            "native test must configure its actual private history before ReadLine"
        );
        if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_ACCEPT_TRACE") {
            let bytes = match std::fs::read(&history) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(error) => panic!("failed to audit private native history: {error}"),
            };
            if retain_test_commands {
                // Only raw broker commands are retained. Interactive credential
                // fixtures keep metadata alone, even for generated test values.
                std::fs::write(format!("{prefix}.{label}.private-history.bin"), &bytes).unwrap();
            }
            std::fs::write(
                format!("{prefix}.{label}.private-history.json"),
                serde_json::to_vec_pretty(&serde_json::json!({
                    "kind":"actual-psreadline-private-test-history",
                    "actualHistoryPath":history,
                    "bytes":bytes.len(),
                    "sha256":hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&bytes)),
                    "testCommandsRetained":retain_test_commands,
                }))
                .unwrap(),
            )
            .unwrap();
        }
    }
}
