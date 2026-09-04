# Fixed remote read capability. Parameters arrive on stdin, never as shell code.
# No writes, home expansion, recursion, imports from cwd, or arbitrary operations.
import os, sys, json, stat, base64

fds = []
try:
    raw = sys.stdin.buffer.readline(16385)
    if len(raw) > 16384:
        raise ValueError('Limit')
    request = json.loads(raw)
    root = request['root']
    parts = root.split('/')
    if not root.startswith('/') or any(p in ('.', '..') for p in parts) or '\\' in root or '\x00' in root:
        raise ValueError('Denied')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    fds.append(fd)
    for part in filter(None, parts):
        fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        fds.append(fd)
    st = os.fstat(fd)
    identity = '%s:%s' % (st.st_dev, st.st_ino)
    if request.get('identity') is not None and identity != request['identity']:
        raise ValueError('Drift')
    operation = request['operation']
    output = {'identity': identity}
    if operation != 'identity':
        path = request['path']
        parts = path.split('/') if path else []
        # Content reads remain confined to Skills. listPaths only opens directories inside the frozen root.
        if (operation != 'listPaths' and parts[:2] != ['.agents', 'skills']) or any(not p or p in ('.', '..') or '\\' in p or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in p) for p in parts):
            raise ValueError('Denied')
        if operation == 'listPaths' and (len(parts) > 32 or len(path.encode('utf-8')) > 2048): raise ValueError('Limit')
        if operation == 'list' and len(parts) != 2:
            raise ValueError('Denied')
        if operation == 'read' and not (len(parts) == 3 and parts[2].endswith('.md') or len(parts) == 4 and parts[3] == 'SKILL.md'):
            raise ValueError('Denied')
        for i, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
            if i < len(parts) - 1 or operation in ('list', 'listPaths'): flags |= os.O_DIRECTORY
            fd = os.open(part, flags, dir_fd=fd)
            fds.append(fd)
        before = os.fstat(fd)
        if operation in ('list', 'listPaths'):
            entries = []
            with os.scandir(fd) as iterator:
                for entry in iterator:
                    if len(entries) >= min(request['limit'], 1024): raise ValueError('Limit')
                    entry.name.encode('utf-8', errors='strict')
                    entries.append({'name': entry.name, 'directory': entry.is_dir(follow_symlinks=False), 'file': entry.is_file(follow_symlinks=False)})
            output['entries'] = sorted(entries, key=lambda e: e['name'].encode('utf-8'))
        elif operation == 'read':
            if not stat.S_ISREG(before.st_mode): raise ValueError('Denied')
            limit = min(request['limit'], 131072)
            if before.st_size > limit: raise ValueError('Limit')
            chunks = []; length = 0
            while True:
                chunk = os.read(fd, min(8192, limit + 1 - length))
                if not chunk: break
                chunks.append(chunk); length += len(chunk)
                if length > limit: raise ValueError('Limit')
            output['bytes'] = base64.b64encode(b''.join(chunks)).decode('ascii')
        else: raise ValueError('Denied')
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('Io')
    sys.stdout.write(json.dumps(output, ensure_ascii=True))
except FileNotFoundError: sys.stdout.write('{"error":"Absent"}')
except PermissionError: sys.stdout.write('{"error":"Denied"}')
except OSError as error:
    import errno
    sys.stdout.write(json.dumps({'error': 'Denied' if error.errno in (errno.ELOOP, errno.ENOTDIR) else 'Io'}))
except (ValueError, KeyError, TypeError) as error:
    code = str(error)
    sys.stdout.write(json.dumps({'error': code if code in ('Denied','Drift','Limit','Io') else 'Denied'}))
finally:
    for fd in reversed(fds): os.close(fd)
