# TLS and endpoint diagnosis

Locate the failing layer for one explicitly identified endpoint. Answer in the user's language. Loading this skill grants no network, file, certificate-management or service-change permission. Never install trust roots, disable verification, modify DNS, renew certificates or restart a service as an implicit diagnostic step.

## Scope and first check

Identify hostname, port, protocol, observed symptom and the client location that sees it. Default the port only when the user's protocol makes it unambiguous, and show the actual destination in the check. Strip credentials from any supplied URL; never include them in tool arguments. Prefer the real DNS name over a guessed IP so SNI and hostname verification remain meaningful.

Use `diagnose_endpoint` on the frozen target with `protocol: https` (or `tls` for a non-HTTP TLS listener) and a bounded timeout. This collector requires Python 3.8+ and its SSL module. It uses that target's DNS resolver and trust store, pins resolved numeric addresses for connection, does not use proxies or follow redirects, and verifies certificates. Do not claim equivalence with a browser, custom application trust store, proxy or another host.

## Interpret the stages

1. **DNS:** distinguish resolution failure from a valid answer. Record returned addresses and collection time. Do not infer authoritative DNS configuration, propagation or all-client consistency from one resolver's result.
2. **TCP:** inspect per-address attempts, selected address and refusal/timeout evidence. One successful address does not verify all A/AAAA backends. Link-local, multicast, unspecified or other prohibited destinations are denied; never retry through shell clients or another tool to bypass that decision.
3. **TLS:** require `verified: true` before reporting identity/trust validation success. Check protocol, cipher, peer certificate names, issuer and validity dates that the tool actually returns. Use reported verification errors to distinguish expiry, hostname mismatch and untrusted chain where possible. A failed handshake may supply no certificate details; do not invent a chain or issuer. This tool does not establish OCSP/revocation status, full intermediate-chain inventory, client-certificate behavior or every supported cipher.
4. **Time:** expiry is relative to the target's clock. If evidence conflicts with the user's client, inspect clock evidence before blaming the certificate. Express remaining validity concretely; use a user-provided renewal threshold rather than an invented severity policy.
5. **HTTP:** status is distinct from TLS validation. A 401/403 can establish a reachable authenticated endpoint; 405/501 may indicate unsupported HEAD. A 3xx is not followed. For an additional destination obtain explicit scope through normal tool authorization; never automatically traverse a redirect. Do not call a site healthy from HEAD alone.

## Correlate and finish

When the endpoint is served by the frozen host and the service is known, use `inspect_service` and a bounded `query_logs` interval to correlate reload failures or handshake errors. Read certificate metadata only through authorized scoped tools; never read private keys or dump environment files.

Report target/vantage point, endpoint, failing layer, observed evidence references and time, likely cause with confidence, checks not performed, and the next smallest discriminating action. A denied or unavailable collector is an evidence gap, not proof that the endpoint is down. Stop on cancellation and do not create continuing background probes.
