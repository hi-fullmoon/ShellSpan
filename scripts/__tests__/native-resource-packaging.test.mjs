import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { nativeInputReleaseDirectory } from '../native-input/integration/resource-paths.mjs';
import {copyNativeRebuildSources} from '../native-input/integration/rebuild-sources.mjs';

const root = path.resolve(import.meta.dirname, '../..');

it('packs an unsupported target twice and rejects a missing catalogue for an admitted target', async () => {
  const artifacts = path.join(root, 'artifacts/tests/native-resource-packaging');
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(path.join(artifacts, 'run-'));
  try {
    for (const name of ['scripts/native-input/prepare-resources.mjs', 'scripts/native-input/integration/frozen-validation.mjs',
      'scripts/native-input/integration/resource-paths.mjs','scripts/native-input/integration/rebuild-sources.mjs', 'scripts/native-input/integration/bash-profiles.mjs', 'protocol/agent/runtime/native-editor-admission.json']) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await copyFile(path.join(root, name), path.join(directory, name));
    }
    const legacy = path.join(directory, 'src-tauri/resources/native-input/generated');
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'retained.txt'), 'owned prior fixture');
    const execute = (target) => spawnSync(process.execPath, ['scripts/native-input/prepare-resources.mjs',
      '--no-build', '--target', target], { cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    const first = execute('unsupported');
    expect(first.status, first.stderr).toBe(0);
    const output = JSON.parse(first.stdout);
    expect(output.directory).toBe(nativeInputReleaseDirectory(directory));
    expect(output.directory).toBe(path.join(directory, 'src-tauri/target/native-input/generated'));
    await expect(readdir(path.join(directory, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
    const manifest = JSON.parse(await readFile(path.join(output.directory, 'resource-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ targets: [], unsupportedHost: true, validationOnly: false });
    expect(await readdir(output.directory)).toEqual(['resource-manifest.json']);
    const missing = execute('x86_64-pc-windows-msvc');
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('Required native editor catalogue missing: editors-windows-x64.json');
    expect(JSON.parse(await readFile(path.join(output.directory, 'resource-manifest.json'), 'utf8'))).toEqual(manifest);
    const second = execute('unsupported');
    expect(second.status, second.stderr).toBe(0);
    const repeated = JSON.parse(second.stdout);
    expect(repeated.previousRetained).toContain(path.join(directory, 'src-tauri/target/native-input/resource-build'));
    expect(JSON.parse(await readFile(path.join(repeated.previousRetained, 'resource-manifest.json'), 'utf8'))).toEqual(manifest);
    expect(await readFile(path.join(legacy, 'retained.txt'), 'utf8')).toBe('owned prior fixture');
    expect(await readdir(output.directory)).toEqual(['resource-manifest.json']);
  } finally {
    const relative = path.relative(artifacts, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe fixture cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});

it('ships the Windows example capture include and excludes build/cache output',async()=>{
  const artifacts=path.join(root,'artifacts/tests/native-resource-packaging');await mkdir(artifacts,{recursive:true});const directory=await mkdtemp(path.join(artifacts,'sources-'));
  try{
    const input=path.join(directory,'input'),output=path.join(directory,'output');
    for(const name of ['src-tauri/native-input-editors/examples','src-tauri/native-input-adapter','src-tauri/vendor/portable-pty','src-tauri/src/terminal_command','src-tauri/native-input-editors/target','src-tauri/native-input-editors/__pycache__'])await mkdir(path.join(input,name),{recursive:true});
    for(const name of ['src-tauri/native-input-editors/examples/windows_acceptance.rs','src-tauri/src/terminal_command/capture.rs','src-tauri/src/terminal_command/protocol.rs'])await copyFile(path.join(root,name),path.join(input,name));
    for(const name of ['target/old.dll','__pycache__/old.pyc'])await writeFile(path.join(input,'src-tauri/native-input-editors',name),'excluded generated fixture');
    await copyNativeRebuildSources(input,output);
    const example=path.join(output,'src-tauri/native-input-editors/examples/windows_acceptance.rs');
    expect(await readFile(path.resolve(path.dirname(example),'../../src/terminal_command/capture.rs'))).toEqual(await readFile(path.join(root,'src-tauri/src/terminal_command/capture.rs')));
    expect(await readFile(path.join(output,'src-tauri/src/terminal_command/protocol.rs'))).toEqual(await readFile(path.join(root,'src-tauri/src/terminal_command/protocol.rs')));
    for(const name of ['target','__pycache__'])await expect(readdir(path.join(output,'src-tauri/native-input-editors',name))).rejects.toMatchObject({code:'ENOENT'});
  }finally{const relative=path.relative(artifacts,directory);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Unsafe fixture cleanup path');await rm(directory,{recursive:true,force:true});}
});
