# Network diagnosis

Diagnose connectivity from the current terminal target and answer in the user's language. Keep commands bounded and within existing permissions. A working directory is unnecessary. Do not change DNS, routes, firewall rules or interfaces as part of diagnosis.

1. Identify the destination, expected protocol/port and observed symptom. Use provided context; ask for a missing destination if the requested connection cannot otherwise be tested.
2. Detect the OS and available tools. Inspect interface addresses and routes (`ip address`, `ip route` on Linux, or available platform equivalents), then resolve only the named destination with an authorized resolver such as `getent` or `dig`. If the resolver query is denied, do not change DNS settings or try another route around the policy.
3. Distinguish DNS failure, missing route, TCP refusal/timeout, TLS error and application response. Probe only a specific endpoint when an available structured tool and the current permission scope authorize that destination; use a short timeout, bounded output and normal TLS verification. Shell network commands such as `curl` may be rejected as unscoped egress by the native runtime. If rejected, record that the endpoint check was unavailable rather than retrying through a wrapper or another command. ICMP failure alone does not prove a host is down.
4. When checking a local service, inspect listening sockets with available tools such as `ss` or `lsof`. Check only relevant destinations and ports; do not scan unrelated networks. Avoid exposing credentials in URLs, headers or diagnostic output.
5. Report where the failure occurs, evidence from both successful and failed checks, and the next targeted action. Quote user-supplied destinations safely when forming arguments.
