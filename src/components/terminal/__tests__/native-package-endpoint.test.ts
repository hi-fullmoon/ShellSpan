import {expect,it} from 'vitest';
import {nativePackageEndpoint} from './native-package-endpoint';
const endpoint='/__native-file-witness/12345678-1234-1234-1234-123456789abc';
it('keeps native development reports relative and explicitly binds installed reports to loopback',()=>{
 expect(nativePackageEndpoint(endpoint,'http://localhost:1420/test')).toBe(endpoint);
 expect(nativePackageEndpoint(endpoint,'http://tauri.localhost/test?reportOrigin=http%3A%2F%2F127.0.0.1%3A32451')).toBe('http://127.0.0.1:32451'+endpoint);
 for(const origin of ['https://127.0.0.1:4','http://example.com:4','http://u:p@127.0.0.1:4','http://127.0.0.1:4/path','http://127.0.0.1:4/?token=secret'])expect(()=>nativePackageEndpoint(endpoint,'http://tauri.localhost/?reportOrigin='+encodeURIComponent(origin))).toThrow('owned package');
 expect(()=>nativePackageEndpoint('/arbitrary','http://localhost:1420')).toThrow('acceptance endpoint');
});
