export function initializationObserverReady(value:unknown,token:string):boolean {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Structured initialization observer required');
  const receipt=value as Record<string,unknown>;
  if(receipt.ready===false)return false;
  if(receipt.ready!==true||receipt.token!==token||typeof receipt.appPid!=='number'||!Number.isSafeInteger(receipt.appPid)||receipt.appPid<=1
    ||typeof receipt.handleCreated!=='string'||!Number.isFinite(Date.parse(receipt.handleCreated))
    ||typeof receipt.sha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.sha256)
    ||receipt.readOnly!==true||receipt.inputInjected!==false||receipt.terminationRequested!==false
    ||JSON.stringify(receipt.observerKinds)!==JSON.stringify(['identity','modules']))throw Error('Exact held App initialization observers required');
  return true;
}
