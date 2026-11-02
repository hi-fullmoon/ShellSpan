import {invokeRetrieveProfilePassword} from '@/lib/ipc/tauri';

// The disposable password is provisioned through the real native keychain API.
// Only this nonsecret reference crosses URLs or evidence files.
export async function nativeP2Password():Promise<string>{
  const reference=new URL(location.href).searchParams.get('nativeP2Credential');
  if(!reference||!/^native-p2-secret-[0-9a-f-]{36}$/.test(reference))throw new Error('Owned credential reference missing');
  const password=await invokeRetrieveProfilePassword(reference);
  if(!password)throw new Error('Owned keychain credential unavailable');
  return password;
}
