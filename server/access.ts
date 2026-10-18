import {createHash,timingSafeEqual} from 'node:crypto';
export type AccessPolicy={mode:'local';port?:number}|{mode:'service';origin:string;token:string};
export function serviceOrigin(value:unknown):URL {
  if(typeof value!=='string'||value.length>2048)throw new Error('Use an HTTPS server origin.');
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Use an HTTPS server origin without a path or credentials.');
  return u;
}
export function validToken(token:unknown):token is string {return typeof token==='string'&&/^[A-Za-z0-9_-]{43,128}$/.test(token);}
export function accessProblem(policy:AccessPolicy,host:string|undefined,origin:string|undefined,authorization:string|undefined):string|null {
  if(policy.mode==='service'){
    const expected=serviceOrigin(policy.origin);
    if(host!==expected.host)return 'Unrecognized server host';
    if(origin&&origin!==expected.origin)return 'Cross-origin access is unavailable';
    if(!validToken(policy.token))return 'Service authentication is unavailable';
    const provided=authorization?.startsWith('Bearer ')?authorization.slice(7):'';
    if(!provided||!timingSafeEqual(createHash('sha256').update(provided).digest(),createHash('sha256').update(policy.token).digest()))return 'Authentication required';
    return null;
  }
  const hosts=new Set([`127.0.0.1:${policy.port??4318}`,`localhost:${policy.port??4318}`,'127.0.0.1:5173','localhost:5173']);
  if(!hosts.has(host??''))return 'Unrecognized local host';
  if(origin&&![...hosts].some(h=>origin==='http://'+h))return 'Cross-origin access is unavailable';
  return null;
}
