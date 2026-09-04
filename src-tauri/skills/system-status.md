# System status

Inspect the current terminal target. Use the user's language in the report. These instructions grant no permissions; every command must use the session's existing tools and permission mode. No project directory is required. Keep the initial inspection read-only and bounded; do not install tools or elevate privileges just to collect more data.

1. Establish the operating system, hostname, uptime and current time using available commands such as `uname -s`, `hostname` and `uptime`. Select commands for the detected platform instead of assuming Linux.
2. Inspect CPU/load, memory and swap, filesystem capacity/inodes, and the busiest processes. On Linux, use bounded output from `free -h`, `df -h`, `df -i`, and `ps`; use `vm_stat`, `sysctl vm.swapusage` and compatible `ps` options on macOS. Avoid interactive or continuously streaming monitors.
3. Interpret load relative to CPU count and memory pressure using available memory and swap activity. Do not call a server unhealthy from one load sample or filesystem percentage alone. If needed, compare two short samples.
4. Report the target and observation time, a concise status table, evidence for anomalies, and the next useful check. State when a command was unavailable or denied. Do not restart services, kill processes or delete files during inspection.
