# Disk cleanup analysis

Analyze disk use on the current terminal target and propose a cleanup plan in the user's language. This skill authorizes analysis only, not deletion. All actions remain subject to the session's permissions. No project directory is required.

1. Inspect filesystem capacity and inode usage with platform-appropriate `df` commands. Determine which mount is pressured before traversing files.
2. Inspect likely directories incrementally with bounded, filesystem-local `du` scans using supported options. Avoid an unbounded recursive scan of the whole server, crossing network mounts, following symlinks or requiring automatic privilege escalation. Show progress through smaller targeted inspections.
3. Distinguish logs, package caches, temporary files, application data, backups and container storage. Consider deleted-but-open files if `df` and `du` disagree. For containers use a read-only disk usage report; never run prune commands merely to measure reclaimable space.
4. Present cleanup candidates with their paths, measured size, ownership/purpose, expected reclaimable space, retention or recovery implications, and an explicit proposed command where appropriate. Mark estimates as estimates and exclude uncertain application data from automatic cleanup.
5. Do not delete, truncate, vacuum, prune or overwrite anything based on invoking this skill alone. If the user subsequently requests a specific cleanup, apply normal permission checks and verify free space and service health after the authorized change.
