# Docker diagnosis

Inspect Docker on the current terminal target and report in the user's language. This skill does not grant permissions or require a project directory. Use bounded read-only commands, and do not install Docker or implicitly elevate privileges.

1. Check that the Docker client and daemon are available. Inspect the current Docker context/endpoint so the report identifies where the daemon actually runs. Do not switch contexts automatically. Explain a missing daemon or denied socket separately from a container failure.
2. Identify the relevant container from the user's message or a concise `docker ps -a` listing. Inspect its state, exit code, restart count, health check and port mappings using narrow `docker inspect --format` fields; avoid dumping environment variables or secrets.
3. Collect bounded recent logs (`docker logs --tail 100 --since 30m CONTAINER`) and a single resource snapshot (`docker stats --no-stream`). Correlate timestamps with host pressure, health failures, OOM evidence and restart loops. Quote identifiers as arguments.
4. Inspect relevant networks, mounts and disk usage only as needed. Use Compose diagnostics only if a known Compose project is available; do not require one for ordinary container checks.
5. Report evidence, likely causes and concrete next steps. Do not restart/recreate containers, pull images, exec mutating commands, remove volumes or prune resources without a corresponding user request and the normal permission checks.
