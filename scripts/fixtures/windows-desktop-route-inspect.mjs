import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const validator = new Ajv2020({ strict:true, allErrors:true });
const validate = validator.compile(JSON.parse(await readFile(new URL('../../protocol/llm/routes.schema.json',import.meta.url),'utf8')));
for (const name of ['.shellspan/shellspan-main.db','.shellspan-dev/shellspan-main.db','.shellspan-dev/shellspan-v1.db','.shellspan-dev/shellspan.db']) {
  let database;
  try {
    database = new DatabaseSync(join(homedir(),name),{readOnly:true});
    const row=database.prepare('SELECT value FROM preferences WHERE key=?').get('llm.routes.v1');
    if (!row) { console.log(JSON.stringify({ database:name, documentPresent:false })); continue; }
    const document=JSON.parse(row.value);
    const valid=validate(document);
    console.log(JSON.stringify({ database:name, valid, routeCount:document.routes?.length,
      defaultSelection:document.defaultSelection,
      schemaErrors:valid ? undefined : validate.errors.map(({ keyword,instancePath,schemaPath })=>({keyword,instancePath,schemaPath})) }));
  } catch(error) { console.log(JSON.stringify({database:name,error:error.code ?? error.name})); }
  finally { database?.close(); }
}
