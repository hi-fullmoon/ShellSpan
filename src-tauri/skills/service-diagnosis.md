# Service diagnosis

Diagnose services on the current terminal target and report in the user's language. Skills do not expand tool permissions. Start with read-only evidence; no project directory is needed. Do not install tools or escalate privileges implicitly.

1. Identify the requested service and symptom from the message. If unspecified, list a small set of failed services using the available service manager; ask for the service when it cannot be identified from evidence.
2. Detect the OS and service manager. For systemd, inspect the exact unit with `systemctl status --no-pager`, relevant `systemctl show` fields, and bounded recent `journalctl -u UNIT --no-pager -n 100` output. Quote the unit name as an argument, never interpolate it as shell code. Use the installed alternatives for launchd, OpenRC or other managers.
3. Correlate exit status, restart count, timestamps, dependencies, listening ports, disk/memory pressure and relevant configuration errors. Avoid dumping environment files, credentials or unrelated logs. If needed, use the service's documented non-mutating validation command.
4. Separate observed facts from probable causes, rank likely causes, and propose the smallest repair with a verification step. Restarting, enabling, reloading or editing a service must follow the user's request and the session's normal permission checks; diagnosis alone does not authorize these actions.
