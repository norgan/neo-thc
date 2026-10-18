import type { DiscoveryInterface, DiscoveryMethod } from './types.js';
function range(value:string) {
  const match=/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value.trim());
  if(!match)return null;
  const parts=match[1].split('.').map(Number),prefix=Number(match[2]);
  if(parts.some((part)=>part>255)||prefix>32)return null;
  const address=parts.reduce((n,part)=>n*256+part,0),size=2**(32-prefix),first=Math.floor(address/size)*size;
  return {first,last:first+size-1,size,prefix};
}
export function formBudget(iface:DiscoveryInterface|undefined,cidr:string,methods:DiscoveryMethod[],portText:string,attemptLimit=16384) {
  const scope=range(cidr),link=iface?range(iface.cidr):null;
  const tokens=portText.split(/[,\n]/).map((value)=>value.trim()).filter(Boolean);
  const ports=tokens.map(Number),uniquePorts=new Set(ports).size;
  const errors:string[]=[];
  if(!iface)errors.push('Choose a source interface.');
  if(!scope)errors.push('Enter a valid IPv4 CIDR.');
  else if(!link||scope.size>256||scope.first<link.first||scope.last>link.last)errors.push('Choose at most 256 addresses inside the selected interface subnet.');
  if(!methods.length)errors.push('Select at least one discovery method.');
  let targets=0;
  if(scope&&link&&scope.size<=256) {
    const own=iface!.address.split('.').reduce((n,part)=>n*256+Number(part),0);
    for(let n=scope.first;n<=scope.last;n++)if(n!==own&&!(link.prefix<=30&&(n===link.first||n===link.last)))targets++;
  }
  if(methods.includes('tcp')&&(!tokens.length||tokens.length>64||tokens.some((value)=>!/^\d{1,5}$/.test(value))||ports.some((port)=>port<1||port>65535)||uniquePorts!==ports.length))
    errors.push('TCP ports: enter 1–64 unique whole numbers from 1 to 65535, separated by commas or new lines.');
  const attempts=methods.includes('tcp')?targets*uniquePorts:0;
  const maxPorts=targets?Math.min(64,Math.floor(attemptLimit/targets)):64;
  if(attempts>attemptLimit)errors.push('TCP budget exceeds '+attemptLimit.toLocaleString('en-US')+' attempts. Choose at most '+maxPorts+' ports for this scope, or reduce the CIDR.');
  return {targets,ports,uniquePorts,attempts,maxPorts,errors};
}
