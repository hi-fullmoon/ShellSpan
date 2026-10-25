import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const entries = {};
async function visit(path, name) {
  let values;
  try { values = await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const value of values.sort((a,b) => a.name.localeCompare(b.name))) {
    const full = join(path,value.name), key = `${name}/${value.name}`;
    if (value.isDirectory()) await visit(full,key);
    else if (value.isFile()) {
      const before = await stat(full);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(full)) hash.update(chunk);
      const after = await stat(full);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`User file changed during read-only audit: ${key}`);
      entries[key] = { bytes:after.size, sha256:hash.digest('hex') };
    }
  }
}
for (const root of ['.shellspan','.shellspan-dev']) await visit(join(homedir(),root),root);
for (const [kind,base] of [['roaming',process.env.APPDATA],['local',process.env.LOCALAPPDATA]]) {
  if (base) for (const name of ['com.shellspan','com.shellspan-dev']) await visit(join(base,name),`${kind}/${name}`);
}
if(process.env.APPDATA) await visit(join(process.env.APPDATA,'Microsoft/Windows/PowerShell/PSReadLine'),'powershell-history');
if(process.env.SHELLSPAN_AUDIT_HISTORY_FILE){
  const path=process.env.SHELLSPAN_AUDIT_HISTORY_FILE;
  try {const metadata=await stat(path);const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
    entries['selected-shell-history']={path,bytes:metadata.size,sha256:hash.digest('hex')};
  }catch(error){if(error.code!=='ENOENT')throw error;entries['selected-shell-history']={path,exists:false};}
}
await writeFile(process.argv[2],JSON.stringify({ kind:'read-only-user-data-hashes', entries },null,2));
