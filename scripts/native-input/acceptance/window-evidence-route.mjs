import assert from 'node:assert/strict';

export function attachNativeWindowEvidence(server,{token,windowsShell,nativeP3,capture,platform=process.platform}){
 const hosts=['windowsPowerShell','powerShell7'];
 if(platform!=='win32'||!hosts.includes(windowsShell??nativeP3))return false;
 assert(/^[a-f0-9-]{36}$/.test(token)&&typeof capture==='function','Owned native window endpoint inputs required');
 let requests=0;
 server.middlewares.use(`/__native-window-evidence/${token}`,async(request,response)=>{
  if(request.method!=='POST'){response.statusCode=405;response.end();return;}
  try{
   assert(++requests<=1,'Only one owned native window capture is admitted');
   const metadata=await capture();
   response.setHeader('Content-Type','application/json');response.end(metadata);
  }catch(error){response.statusCode=500;response.end(String(error));}
 });
 return true;
}
