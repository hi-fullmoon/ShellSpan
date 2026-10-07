"""Prepare an ordinary current-code compatibility snapshot, not sandbox ingress.

Only Git-listed application/build sources are selected; credentials, Git internals,
host caches and generated outputs are not transferred. No original file is changed.
This tool does not provide the unresolved adversarial import/export contract.
"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path(sys.argv[1]).resolve()
if OUTPUT == ROOT or ROOT in OUTPUT.parents:
    raise ValueError('Use a new compatibility directory outside the repository')
OUTPUT.mkdir(exist_ok=False)
paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
root_files = {'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'index.html', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'CHANGELOG.md', '.gitignore', 'docs/releasing.md', 'AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'rust-toolchain.toml', 'cliff.toml'}
root_files.update({f'docs/design/deployment-center-product-phase-{phase}-evidence.json' for phase in ['2', '3']})
root_files.add('docs/design/deployment-center-product-phase-4-lifecycle-evidence.json')
root_files.add('.agents/skills/shadcn/SKILL.md')
selected = []
for name in sorted(set(paths)):
    path = Path(name)
    if not name or not (name in root_files or path.parts[0] in {'src', 'src-tauri', 'scripts', 'public', 'protocol', 'patches', '.github', 'tests'}):
        continue
    if any(part in {'target', 'gen', 'node_modules', '.git'} or part.startswith('.env') for part in path.parts):
        continue
    source = ROOT / path
    if not source.exists():
        continue  # Preserve working-tree deletions.
    if source.is_symlink() or not source.is_file() or source.stat().st_nlink != 1:
        raise ValueError(f'Compatibility input needs explicit review: {name}')
    destination = OUTPUT / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    selected.append({'path': name, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()})
(OUTPUT / 'snapshot-manifest.json').write_text(json.dumps(selected, indent=2) + '\n')
shutil.copy2(Path(__file__).with_name('build-compat.Dockerfile'), OUTPUT / 'Dockerfile')
shutil.copy2(Path(__file__).with_name('run_build_compat.sh'), OUTPUT / 'run_build_compat.sh')
print(json.dumps({'snapshot': str(OUTPUT), 'files': len(selected), 'manifestSha256': hashlib.sha256((OUTPUT / 'snapshot-manifest.json').read_bytes()).hexdigest()}))
