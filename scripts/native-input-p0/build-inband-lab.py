"""Build only an isolated C entry-point copy against the frozen native library."""
import hashlib
import json
import shutil
import subprocess
from acceptance import ROOT

out=ROOT/'artifacts/tests/native-input-p0/inband-display-lab';out.mkdir(parents=True,exist_ok=True)
source=out/'bridge.c';shutil.copy2(ROOT/'scripts/native-input-p0/bridge.c',source)
patch=ROOT/'scripts/native-input-p0/inband-display.patch'
subprocess.run(['patch','--batch','-p1','-i',str(patch)],cwd=out,check=True)
build=ROOT/'artifacts/tests/native-input-p0/build-darwin'
upstream=ROOT/'artifacts/tests/native-input-p0/upstream/bash-5.3'
includes=[build/'readline-8.3.6/install/include',build/'bash-5.3-readline-8.3.6',upstream,upstream/'include']
library=build/'debug/libshellspan_native_input_p0.a'
subprocess.run(['cc','-bundle','-undefined','dynamic_lookup',*[f'-I{p}' for p in includes],
    *[f'-I{p/"lib"}' for p in includes],'-I/opt/homebrew/opt/readline/include',str(source),str(library),
    '-lpthread','-ldl','-lm','-o',str(out/'bridge.so')],check=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
(out/'manifest.json').write_text(json.dumps(dict(platform='macOS arm64 only',
    sourceSha256=sha(source),patchSha256=sha(patch),librarySha256=sha(library),bridgeSha256=sha(out/'bridge.so'),
    scope='isolated documented OSC user-variable transport; custom display-only lab binding'),indent=2))
print(out)
