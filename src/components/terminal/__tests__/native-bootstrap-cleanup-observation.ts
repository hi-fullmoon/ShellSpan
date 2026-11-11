export function nativeBootstrapCleanupObservation(status:number,value:unknown):Record<string,unknown>|null{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Structured owned cleanup observation required');
 const record=value as Record<string,unknown>;
 if(status===200){
  const bootstrap=record.nativeBootstrap;
  if(!bootstrap||typeof bootstrap!=='object'||Array.isArray(bootstrap)||!('bootstraps'in bootstrap)||!Array.isArray(bootstrap.bootstraps))throw Error('Actual bootstrap cleanup witness required');
  return record;
 }
 if(status===503&&record.kind==='scratch-file'&&record.observationAvailable===false
   &&typeof record.stage==='string'&&['resource-hash','module-hash'].includes(record.stage)
   &&typeof record.code==='string'&&['EACCES','EPERM','EBUSY'].includes(record.code))return null;
 throw Error('Owned scratch cleanup observation unavailable');
}
