"""Application-owned read-only collector. Inputs are validated by native admission.

Uses standard-library protocol parsers, never shell=True. stdout is one bounded JSON
document; subprocess diagnostics are returned only as bounded evidence. Python 3.8+.
"""
import base64
import hashlib
import http.client
import ipaddress
import json
import os
import platform
import selectors
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time

MAX_OUTPUT = 240 * 1024
DEADLINE = 0
CHILDREN = set()


class CollectionError(Exception):
    def __init__(self, code, detail):
        self.code, self.detail = code, detail


def remaining():
    value = DEADLINE - time.monotonic()
    if value <= 0:
        raise TimeoutError("total diagnostic deadline exceeded")
    return value


def alarm(_signum, _frame):
    raise TimeoutError("total diagnostic deadline exceeded")


def command(argv, limit=64 * 1024, on_line=None):
    """Drain both pipes with a single deadline and hard byte budget."""
    binary = shutil.which(argv[0], path=os.defpath + ":/usr/sbin:/sbin")
    if not binary:
        raise CollectionError("dependencyMissing", argv[0])
    env = {"PATH": os.defpath + ":/usr/local/bin", "LC_ALL": "C", "SYSTEMD_PAGER": "cat", "SYSTEMD_COLORS": "0"}
    child = subprocess.Popen([binary] + argv[1:], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    CHILDREN.add(child)
    output, error = bytearray(), bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, output)
            selector.register(child.stderr, selectors.EVENT_READ, error)
            while selector.get_map():
                for key, _ in selector.select(min(remaining(), 0.1)):
                    block = os.read(key.fileobj.fileno(), 8192)
                    if not block:
                        selector.unregister(key.fileobj)
                        continue
                    key.data.extend(block)
                    if on_line and key.data is output:
                        while b"\n" in output:
                            line, _, rest = output.partition(b"\n")
                            output[:] = rest
                            if len(line) > limit:
                                raise CollectionError("outputLimit", "one journal record exceeded the collection budget")
                            if line and not on_line(json.loads(line)):
                                return "", error.decode("utf-8", "replace")[:2048]
                    if len(output) + len(error) > limit:
                        raise CollectionError("outputLimit", "command output exceeded the collection budget")
            code = child.wait(timeout=remaining())
        if on_line and output:
            on_line(json.loads(output))
            output.clear()
        if code:
            # stderr is untrusted evidence, never an instruction or a health conclusion.
            raise CollectionError("commandFailed", {"exitCode": code, "stderr": error.decode("utf-8", "replace")[:2048]})
        return output.decode("utf-8", "replace"), error.decode("utf-8", "replace")[:2048]
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdout.close()
        child.stderr.close()
        CHILDREN.discard(child)


def observation(fn):
    started = time.monotonic()
    try:
        result = {"status": "ok", "data": fn()}
    except CollectionError as error:
        result = {"status": "unavailable", "code": error.code, "detail": error.detail}
    except (OSError, ValueError, AttributeError) as error:
        result = {"status": "unavailable", "code": type(error).__name__, "detail": str(error)[:512]}
    result["durationMs"] = round((time.monotonic() - started) * 1000)
    return result


def inspect_host(args):
    def memory():
        if platform.system() == "Darwin":
            total, _ = command(["sysctl", "-n", "hw.memsize"])
            return {"totalBytes": int(total), "availableBytes": None,
                    "limitations": ["available memory is not collected on Darwin"]}
        total = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
        if total <= 0:
            raise CollectionError("unsupported", "physical memory metric unavailable")
        return {"totalBytes": total, "availableBytes": None,
                "limitations": ["host physical memory; cgroup limits and available memory are not inferred"]}

    def disk():
        usage = shutil.disk_usage("/")
        stats = os.statvfs("/")
        return {"path": "/", "totalBytes": usage.total, "usedBytes": usage.used,
                "freeBytes": usage.free, "availableBytes": stats.f_bavail * stats.f_frsize,
                "totalInodes": stats.f_files, "availableInodes": stats.f_favail,
                "limitations": ["root filesystem only; application volumes require separate inspection"]}

    collectors = {
        "system": lambda: {"os": platform.system(), "release": platform.release(),
                           "architecture": platform.machine(), "hostname": socket.gethostname(),
                           "pythonVersion": platform.python_version()},
        "cpu": lambda: {"logicalCount": os.cpu_count(), "loadAverage1m5m15m": list(os.getloadavg()),
                        "limitations": ["load averages are not CPU utilization; host values may exceed container quota"]},
        "memory": memory,
        "disk": disk,
        "capabilities": lambda: {"commands": {name: shutil.which(name) is not None for name in
                                               ["systemctl", "journalctl", "docker", "ss", "lsof", "nginx"]},
                                 "systemdRunning": os.path.isdir("/run/systemd/system"),
                                 "tlsVerification": True},
    }
    return {"observations": {field: observation(collectors[field]) for field in args.get("fields") or collectors}}


def require_systemd():
    if platform.system() != "Linux" or not os.path.isdir("/run/systemd/system"):
        raise CollectionError("unsupported", "this tool requires a running systemd manager on Linux")


def inspect_service(args):
    require_systemd()
    properties = ["Id", "LoadState", "ActiveState", "SubState", "Result", "MainPID",
                  "ExecMainCode", "ExecMainStatus", "NRestarts", "Type",
                  "ActiveEnterTimestampMonotonic", "InactiveEnterTimestampMonotonic"]
    values = {}
    for prop in properties:
        # --value avoids a custom parser for systemctl's property format.
        value, _ = command(["systemctl", "show", "--no-pager", "--no-ask-password", "--value", "--property=" + prop, "--", args["service"]], 8192)
        value = value.strip()
        numeric = prop in {"MainPID", "ExecMainCode", "ExecMainStatus", "NRestarts",
                           "ActiveEnterTimestampMonotonic", "InactiveEnterTimestampMonotonic"}
        values[prop] = int(value) if numeric and value else value or None
    return {"manager": "systemd", "service": args["service"], "properties": values,
            "consistency": "sequential property observations; state can change during collection",
            "limitations": ["unit state does not establish application health; no logs or environment were read"]}


def query_logs(args):
    require_systemd()
    binding = {key: args.get(key) for key in ["service", "sinceUnixMs", "untilUnixMs", "keyword"]}
    binding["targetId"] = args["_targetId"]
    fingerprint = hashlib.sha256(json.dumps(binding, sort_keys=True).encode()).hexdigest()
    after = None
    if args.get("cursor"):
        try:
            token = json.loads(base64.urlsafe_b64decode(args["cursor"]))
            after = token["after"]
            if token["query"] != fingerprint or not isinstance(after, str) or len(after) > 2048 or any(ord(c) < 32 for c in after):
                raise ValueError("cursor scope mismatch")
        except (ValueError, KeyError, TypeError) as error:
            raise CollectionError("invalidCursor", "cursor does not match this target and query") from error
    argv = ["journalctl", "--no-pager", "--no-tail", "--output=json", "--all", "--unit=" + args["service"],
            "--until=@{:.3f}".format(args["untilUnixMs"] / 1000)]
    if after:
        # Older systemd forbids combining --since with a cursor. Include the
        # anchor once to verify it still exists and belongs to this time window.
        argv.append("--cursor=" + after)
    else:
        argv.append("--since=@{:.3f}".format(args["sinceUnixMs"] / 1000))
    # The streaming consumer stops and reaps journalctl at the page boundary;
    # no tail-based -n option may skip the beginning of the requested interval.
    argv.append("--output-fields=MESSAGE,__CURSOR,__REALTIME_TIMESTAMP,_BOOT_ID,PRIORITY,_SYSTEMD_UNIT")
    entries, scanned, last, more, entry_bytes = [], 0, after, False, 0
    maximum = args.get("maxEntries", 100)
    anchor_pending = after is not None

    def consume(record):
        nonlocal scanned, last, more, entry_bytes, anchor_pending
        timestamp_us = int(record.get("__REALTIME_TIMESTAMP", 0))
        if anchor_pending:
            if record.get("__CURSOR") != after or not args["sinceUnixMs"] * 1000 <= timestamp_us <= args["untilUnixMs"] * 1000:
                raise CollectionError("staleCursor", "journal cursor is absent or outside the requested interval")
            anchor_pending = False
            return True
        if scanned >= 2000 or len(entries) >= maximum or entry_bytes >= 96 * 1024:
            more = True
            return False
        if not isinstance(record.get("__CURSOR"), str):
            raise CollectionError("invalidOutput", "journal record lacks a continuation cursor")
        last = record["__CURSOR"]
        scanned += 1
        if not args["sinceUnixMs"] * 1000 <= timestamp_us <= args["untilUnixMs"] * 1000:
            return True
        message = record.get("MESSAGE")
        if not isinstance(message, str):
            message = "[non-text journal message omitted]"
        if args.get("keyword") and args["keyword"] not in message:
            return True
        entry = {"timestampUnixUs": timestamp_us,
                        "bootId": record.get("_BOOT_ID"), "priority": record.get("PRIORITY"),
                        "source": record.get("_SYSTEMD_UNIT", args["service"]),
                        "message": message[:2048], "messageTruncated": len(message) > 2048}
        entry_bytes += len(json.dumps(entry).encode())
        entries.append(entry)
        return True

    _, warning = command(argv, 256 * 1024, on_line=consume)
    if anchor_pending:
        raise CollectionError("staleCursor", "journal cursor is no longer readable")
    cursor = base64.urlsafe_b64encode(json.dumps({"query": fingerprint, "after": last}).encode()).decode() if more else None
    return {"source": "systemdJournal", "service": args["service"], "entries": entries,
            "scannedRecords": scanned, "nextCursor": cursor, "hasMore": more,
            "truncated": more or any(entry["messageTruncated"] for entry in entries),
            "accessScope": "records visible to the connected OS user", "warning": warning or None,
            "limitations": ["retention, rotation and journal permissions can hide records; an empty result is not proof of health"]}


def prohibited_address(value, policy):
    ip = ipaddress.ip_address(value)
    ip = getattr(ip, "ipv4_mapped", None) or ip
    return (ip in {ipaddress.ip_address(address) for address in policy["addresses"]}
            or ip.is_link_local or ip.is_multicast or ip.is_unspecified
            or (ip.is_reserved and not ip.is_loopback))


def diagnose_endpoint(args):
    host = args["host"].strip("[]")
    port, protocol = args["port"], args["protocol"]
    stages = {name: {"status": "notRun"} for name in ["dns", "tcp", "tls", "http"]}
    output = {"host": host, "port": port, "protocol": protocol, "stages": stages,
              "vantagePoint": "frozenTarget", "redirectsFollowed": False,
              "limitations": ["one successful address is sampled; this does not validate every backend or a business transaction"]}
    # This policy is compiled into native admission and injected as a private
    # argument. Model arguments cannot override it. Check again after resolution.
    policy = args["_networkDenyList"]
    if host.lower().rstrip(".") in policy["hosts"]:
        stages["dns"] = {"status": "denied", "code": "prohibitedHost"}
        return output
    started = time.monotonic()
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        stages["dns"] = {"status": "failed", "code": "resolutionFailed", "detail": str(error)[:512]}
        return output
    unique = []
    for family, socktype, proto, _, address in addresses:
        if address not in [entry[3] for entry in unique]:
            unique.append((family, socktype, proto, address))
    if len(unique) > 16:
        raise CollectionError("addressLimit", "resolution returned more than 16 addresses")
    stages["dns"] = {"status": "ok", "addresses": [entry[3][0] for entry in unique],
                     "durationMs": round((time.monotonic() - started) * 1000)}
    for _, _, _, address in unique:
        if prohibited_address(address[0], policy):
            stages["tcp"] = {"status": "denied", "code": "prohibitedAddress", "address": address[0]}
            return output
    stream, attempts = None, []
    for family, socktype, proto, address in unique:
        candidate = socket.socket(family, socktype, proto)
        started = time.monotonic()
        try:
            candidate.settimeout(min(remaining(), 3))
            candidate.connect(address)  # Numeric resolved sockaddr; no second DNS lookup.
            stream = candidate
            attempts.append({"address": address[0], "status": "ok", "durationMs": round((time.monotonic() - started) * 1000)})
            break
        except OSError as error:
            candidate.close()
            attempts.append({"address": address[0], "status": "failed", "code": type(error).__name__, "errno": error.errno})
    stages["tcp"] = {"status": "ok" if stream else "failed", "attempts": attempts}
    if not stream:
        return output
    try:
        if protocol in ("tls", "https"):
            started = time.monotonic()
            try:
                stream.settimeout(remaining())
                stream = ssl.create_default_context().wrap_socket(stream, server_hostname=host)
                certificate = stream.getpeercert()
                expires = ssl.cert_time_to_seconds(certificate["notAfter"])
                stages["tls"] = {"status": "ok", "verified": True, "version": stream.version(),
                                 "cipher": stream.cipher()[0], "certificate": certificate,
                                 "expiresUnixMs": round(expires * 1000),
                                 "daysRemaining": round((expires - time.time()) / 86400, 2),
                                 "durationMs": round((time.monotonic() - started) * 1000)}
            except (ssl.SSLError, OSError) as error:
                stages["tls"] = {"status": "failed", "verified": False, "code": type(error).__name__,
                                 "verifyCode": getattr(error, "verify_code", None), "detail": str(error)[:512]}
                return output
        if protocol in ("http", "https"):
            connection = http.client.HTTPConnection(host, port, timeout=remaining())
            connection.sock = stream
            started = time.monotonic()
            try:
                stream.settimeout(remaining())
                connection.request("HEAD", args.get("path", "/"), headers={"Connection": "close"})
                response = connection.getresponse()
                stages["http"] = {"status": "ok", "statusCode": response.status,
                                  "method": "HEAD", "contentType": (response.getheader("Content-Type") or "")[:256],
                                  "durationMs": round((time.monotonic() - started) * 1000),
                                  "healthy": None, "limitations": ["status is protocol evidence; expected application status was not supplied"]}
            except (OSError, http.client.HTTPException) as error:
                stages["http"] = {"status": "failed", "code": type(error).__name__, "detail": str(error)[:512]}
            finally:
                connection.close()
    finally:
        stream.close()
    return output


def main():
    global DEADLINE
    args = json.loads(base64.b64decode(sys.argv[2]))
    DEADLINE = time.monotonic() + args.get("timeoutMs", 10000) / 1000
    result = {"schemaVersion": 1, "collectedAtUnixMs": round(time.time() * 1000),
              "targetId": args["_targetId"], "truncated": False}
    signal.signal(signal.SIGALRM, alarm)
    signal.setitimer(signal.ITIMER_REAL, remaining())
    try:
        result.update({"status": "ok", "data": {
            "inspect_host": inspect_host, "inspect_service": inspect_service,
            "query_logs": query_logs, "diagnose_endpoint": diagnose_endpoint,
        }[sys.argv[1]](args)})
        result["truncated"] = result["data"].get("truncated", False)
    except CollectionError as error:
        result.update(status="unavailable", code=error.code, detail=error.detail)
    except (TimeoutError, subprocess.TimeoutExpired):
        result.update(status="timedOut", code="deadlineExceeded")
    except Exception as error:
        result.update(status="unavailable", code=type(error).__name__, detail=str(error)[:512])
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for child in list(CHILDREN):
            child.kill()
            child.wait()
    encoded = json.dumps(result, ensure_ascii=True)
    if len(encoded.encode()) > MAX_OUTPUT:
        encoded = json.dumps({"schemaVersion": 1, "targetId": args["_targetId"],
                              "collectedAtUnixMs": result["collectedAtUnixMs"],
                              "status": "unavailable", "code": "outputLimit", "truncated": True})
    print(encoded)


if __name__ == "__main__":
    main()
