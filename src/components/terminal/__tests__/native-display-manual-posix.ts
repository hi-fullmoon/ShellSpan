import {quotePosixFileSource} from './native-file-chain-posix';

export function macDisplayOutputCommand(payload:string):string{
 if(payload.includes('\0'))throw Error('Display fixture cannot contain NUL');
 const bytes=new TextEncoder().encode(payload+'\n');
 const encoded=btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(''));
 // A single ASCII input line avoids mistaking echoed multiline source for
 // selected stdout. macOS base64 performs the actual UTF-8 output decoding.
 return `printf %s ${quotePosixFileSource(encoded)} | /usr/bin/base64 -D\r`;
}
