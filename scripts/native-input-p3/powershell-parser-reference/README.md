# Ordinary ConsoleHost parser reference

This Windows-only test utility runs fixed, one-line test cases through a real
interactive ConsoleHost and ConPTY. It supplies ordinary terminal cursor-query
responses from a VT100 screen model. It does not load NIP, construct private
protocol messages, create an Agent, or prove native acceptance.

Build with the repository's Rust toolchain and this standalone locked manifest.
Arguments are the reviewed shell executable, a JSON array of `{id,source,expect}`
cases, and a fresh absolute evidence directory beneath the workspace's
`.artifacts/tests/`. All source cases are sent once. `expect` is an observation
gate; a missing observation retains a failure and stops the remaining cases.

The pinned project PSReadLine 2.4.5 is loaded without the native adapter. The
initial command sets an owned history path and `SaveNothing` before the first
ReadLine, checks those options, and reports the real host/reader versions.
HOME, USERPROFILE, APPDATA, LOCALAPPDATA and the module-analysis cache are isolated.
No system execution-policy or trust setting is changed.

Windows PowerShell/.NET Framework fails initialization when launched with a
verbatim `\\?\` executable path. The utility validates an ordinary absolute
path and preserves its launch spelling. History-path checks compare Windows
full-path identities rather than slash spelling.

The utility owns and stops only its created child. It retains raw PTY bytes,
screen observations, per-case body-effect readings and a cleanup outcome. A
waited/terminated host is not a successful source receipt. Observations must be
audited separately from native App/model results. Do not replay an unknown
operation using this reference utility.
