"""Fixed, artifact-bound existing Compose executor. Never print remote content."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def member(root, relative):
    path = root / relative
    require(not Path(relative).is_absolute() and ".." not in Path(relative).parts, "PATH_BOUNDARY")
    require(path.resolve() == path.absolute(), "SYMLINK_BOUNDARY")
    require(path.is_relative_to(root), "PATH_BOUNDARY")
    return path


def run(args, root, capture=False):
    environment = {key: os.environ[key] for key in ("PATH", "HOME", "DOCKER_CONFIG") if key in os.environ}
    result = subprocess.run(args, cwd=root, env=environment, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=120, check=False)
    require(result.returncode == 0, "COMMAND_FAILED")
    return result.stdout.decode() if capture else ""


def atomic_copy(source, destination, executable=False):
    destination.parent.mkdir(parents=True, exist_ok=True)
    previous = destination.stat() if destination.exists() else None
    mode = previous.st_mode & 0o777 if previous else (0o755 if executable else 0o644)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
        try:
            with source.open("rb") as content:
                shutil.copyfileobj(content, temporary)
            temporary.flush()
            os.fsync(temporary.fileno())
            if previous:
                current = temporary_path.stat()
                if (current.st_uid, current.st_gid) != (previous.st_uid, previous.st_gid):
                    os.chown(temporary_path, previous.st_uid, previous.st_gid)
            os.chmod(temporary_path, mode)
            temporary_path.replace(destination)
        finally:
            temporary_path.unlink(missing_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def check_http(check):
    opener = urllib.request.build_opener(NoRedirect)
    try:
        response = opener.open(check["url"], timeout=5)
    except urllib.error.HTTPError as response_error:
        response = response_error
    with response:
        require(response.status == check["status"], "HTTP_STATUS")
        if check.get("location"):
            require(response.headers.get("Location") == check["location"], "HTTP_REDIRECT")
        if check.get("jsonFields"):
            document = json.loads(response.read(1024 * 1024 + 1))
            require(isinstance(document, dict), "HTTP_JSON")
            require(all(document.get(key) == value for key, value in check["jsonFields"].items()), "HTTP_JSON")


def main():
    os.umask(0o077)
    root, staging = Path(sys.argv[1]), Path(sys.argv[2])
    require(root.resolve() == root and staging.resolve() == staging, "DIRECTORY_BOUNDARY")
    image = sys.argv[3]
    manifest = json.loads(member(staging, "config-host.json").read_text())
    config = manifest["config"]
    state = member(root, ".shellspan")
    state.mkdir(exist_ok=True)
    lock = member(root, ".shellspan/host-compose.lock")
    with lock.open("a") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        base = ["docker", "compose", "--project-directory", str(root), "--project-name", manifest["projectName"],
                "--env-file", str(member(root, config["environmentFile"]))]
        compose = base.copy()
        for path in manifest["composeFiles"] + config["overrideFiles"]:
            compose.extend(["-f", str(member(root, path))])
        run(compose + ["config", "--quiet"], root)
        ids = run(compose + ["ps", "-q", manifest["service"]], root, True).split()
        require(ids, "EXISTING_SERVICE_MISSING")
        prior = json.loads(run(["docker", "inspect"] + ids, root, True))
        require(all(item["Config"]["Labels"].get("com.docker.compose.project") == manifest["projectName"] for item in prior), "PROJECT_IDENTITY")
        files = [(member(staging, entry["component"]), member(root, entry["destination"]), entry["executable"]) for entry in manifest["files"]]
        require(all(source.is_file() and (not destination.exists() or destination.is_file()) for source, destination, _ in files), "FILE_BOUNDARY")
        prospective = base.copy()
        for path in manifest["composeFiles"]:
            entry = next(item for item in manifest["files"] if item["destination"] == path)
            prospective.extend(["-f", str(member(staging, entry["component"]))])
        for path in config["overrideFiles"]:
            prospective.extend(["-f", str(member(root, path))])
        prospective.extend(["-f", str(member(staging, "compose.yaml"))])
        run(prospective + ["config", "--quiet"], root)
        backup = member(staging, "host-backup")
        backup.mkdir()
        # Archive first, then run the server's explicitly selected backup program.
        # Its contract is exit 0 only after validating its backup contents.
        added = []
        for _, destination, _ in files:
            relative = destination.relative_to(root)
            if destination.exists():
                saved = backup / "files" / relative
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(destination, saved)
            else:
                added.append(str(relative))
        active = member(root, ".shellspan/host-image.yaml")
        if active.exists():
            shutil.copy2(active, backup / "previous-image.yaml")
        (backup / "recovery.json").write_text(json.dumps({"addedFiles": added, "images": [
            {"id": item["Image"], "reference": item["Config"]["Image"]} for item in prior]}))
        run(["bash", str(member(root, config["backup"]["script"]))] + config["backup"]["arguments"], root)
        for source, destination, executable in files:
            member(root, str(destination.relative_to(root)))
            atomic_copy(source, destination, executable)
        atomic_copy(member(staging, "compose.yaml"), active)
        compose.extend(["-f", str(active)])
        run(compose + ["config", "--quiet"], root)
        run(compose + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", manifest["service"]], root)
        for service in config["recreateServices"]:
            run(compose + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", service], root)
        expected = run(["docker", "image", "inspect", "--format", "{{.Id}}", image], root, True).strip()
        deadline = time.monotonic() + 90
        while True:
            try:
                for service in [manifest["service"]] + config["recreateServices"]:
                    ids = run(compose + ["ps", "-q", service], root, True).split()
                    require(ids, "SERVICE_MISSING")
                    containers = json.loads(run(["docker", "inspect"] + ids, root, True))
                    for container in containers:
                        require(container["State"]["Running"], "SERVICE_STOPPED")
                        require(container["State"].get("Health", {}).get("Status", "healthy") == "healthy", "SERVICE_UNHEALTHY")
                        if service == manifest["service"]:
                            require(container["Image"] == expected, "IMAGE_IDENTITY")
                for check in config["checks"]:
                    check_http(check)
                break
            except (RuntimeError, OSError, ValueError):
                require(time.monotonic() < deadline, "VERIFICATION_FAILED")
                time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Do not disclose subprocess output, HTTP bodies or environment values.
        sys.stderr.write("DEPLOYMENT_HOST_COMPOSE_FAILED\n")
        sys.exit(1)
