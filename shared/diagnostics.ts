import type {DiagnosticFinding,DiagnosticReport,DnsCheck} from './types.js';

export function canonicalAddress(address:string):string {
  try {return address.includes(':')?new URL('http://['+address+']/').hostname.slice(1,-1):address;}catch{return address;}
}
export function connectionAddressProblem(address:string):string|null {
  const value=canonicalAddress(address).toLowerCase();
  if(value.includes('%'))return 'Link-local scope identifiers are not supported by these connection checks.';
  if(value.includes(':')) {
    if(value==='::'||value==='::1'||value.startsWith('::ffff:')||/^ff|^fe[89ab]/.test(value))
      return 'Unspecified, loopback, mapped, multicast and link-local endpoints are excluded.';
  }else {
    const [a,b]=value.split('.').map(Number);
    if(a===0||a===127||a>=224||(a===169&&b===254))return 'Unspecified, loopback, multicast and link-local endpoints are excluded.';
  }
  return null;
}
export function diagnosticAddresses(report:DiagnosticReport):string[] {
  return [...new Set(report.dns.flatMap((row)=>row.answers.map((answer)=>canonicalAddress(answer.address))))];
}
export function diagnosticFindings(report:DiagnosticReport):DiagnosticFinding[] {
  if(!report.complete)return [];
  const findings:DiagnosticFinding[]=[];
  const add=(code:string,title:string,detail:string,nextStep:string)=>findings.push({code,title,detail,nextStep});
  if(report.kind==='dns') {
    const direct=report.dns.filter((row)=>row.recordType!=='system'),system=report.dns.find((row)=>row.recordType==='system');
    const answers=direct.filter((row)=>row.status==='answer');
    if(direct.some((row)=>row.durationMs>=500))add('slow_dns','Some DNS checks took at least 500 ms',
      'This comparison threshold flags potentially slow lookups in this snapshot. It is not a universal DNS service limit; a warm cache can make a later lookup faster.',
      'Repeat with the same configured resolvers during a stall and compare timing, timeout and response outcomes.');
    if(direct.some((row)=>row.source.includes(':')&&['timeout','unavailable','refused','servfail'].includes(row.status)&&
      direct.some((peer)=>peer.source!==row.source&&peer.recordType===row.recordType&&peer.status==='answer')))
      add('ipv6_resolver','A query to an IPv6 DNS server failed while another resolver answered',
        'This concerns the resolver connection over IPv6. It is separate from whether the service publishes AAAA records or serves traffic over IPv6.',
        'Check this client’s IPv6 route to that configured resolver and whether its advertised DNS address is valid.');
    if(!answers.length&&direct.length)add('dns_failed','The selected DNS checks did not return an address',
      'The individual outcomes distinguish NXDOMAIN, no record, refusal, SERVFAIL and timeout. This does not identify the cause.',
      'Check the configured resolver and authoritative records for this name. Repeat after the connection has recovered.');
    if(answers.some((row)=>row.recordType==='A')&&direct.some((row)=>row.recordType==='AAAA')&&
      direct.filter((row)=>row.recordType==='AAAA').every((row)=>row.status==='no_data'||row.status==='nxdomain'))
      add('ipv4_only','IPv4 records are available; IPv6 records are absent',
        'An IPv4-only service can work normally. Missing AAAA records alone do not establish an IPv6 fault.',
        'Check an approved IPv4 endpoint. Investigate AAAA only if this service is intended to support IPv6.');
    const byResolver=new Map<string,DnsCheck[]>();
    for(const row of direct)byResolver.set(row.source,[...(byResolver.get(row.source)??[]),row]);
    const sets=[...byResolver.values()].map((rows)=>[...new Set(rows.flatMap((row)=>row.answers.map((answer)=>canonicalAddress(answer.address))))].sort().join(','));
    if(new Set(sets).size>1)add('resolver_difference','The selected resolvers disagree',
      'Different answers or errors can reflect split DNS, caching, filtering or load balancing. TTLs are recorded; disagreement alone does not prove a bad record.',
      'Compare the intended internal/external DNS view and the DNS servers advertised to the affected client.');
    if(system&&answers.length) {
      const directSet=[...new Set(answers.flatMap((row)=>row.answers.map((answer)=>canonicalAddress(answer.address))))].sort().join(',');
      const systemSet=[...new Set(system.answers.map((answer)=>canonicalAddress(answer.address)))].sort().join(',');
      if(system.status!=='answer'||directSet!==systemSet)add('system_difference','Operating-system resolution differs from direct DNS',
        'The operating system can use hosts entries, VPN policy, caches or other configured resolvers. Browser and application DNS can differ again.',
        'Compare this host’s DNS/VPN/hosts configuration with the affected application, then repeat the same checks after wake.');
    }
    if(diagnosticAddresses(report).length)add('check_connections','Addresses were returned; connection paths have not been tested',
      'DNS answers do not establish TCP reachability, TLS trust or application health.',
      'Select the exact returned IPv4/IPv6 addresses below and check the service port.');
  }else if(report.connections.length) {
    const v4=report.connections.filter((row)=>row.family===4),v6=report.connections.filter((row)=>row.family===6);
    if(v4.some((row)=>row.tcp==='connected')&&v6.length&&v6.every((row)=>row.tcp!=='connected'))
      add('ipv6_path','IPv4 connected; the tested IPv6 paths did not',
        'This supports a difference in the tested connection paths at this time. It does not prove which path an application selected or identify a router fault.',
        'Check that the AAAA records match the server, then inspect its IPv6 route, listener and firewall for this port.');
    if(v6.some((row)=>row.tcp==='connected')&&v4.length&&v4.every((row)=>row.tcp!=='connected'))
      add('ipv4_path','IPv6 connected; the tested IPv4 paths did not',
        'The measured difference is specific to these addresses, this port and this collector.',
        'Check the A records, IPv4 route, listener and firewall for this port.');
    if(report.connections.some((row)=>row.tls==='certificate_error'))
      add('tls_identity','A TLS certificate failed verification',
        'TCP reached the endpoint, but its certificate did not validate for the requested hostname. This is distinct from name resolution or an unreachable IPv6 path.',
        'Check the certificate name, expiry and trust chain at the selected endpoint.');
    if(report.connections.every((row)=>row.tcp==='connected'&&(row.tls==='verified'||row.tls==='not_requested')))
      add('transport_passed','The selected connection checks passed',
        'This verifies TCP and, when selected, hostname-verified TLS. It does not test login, HTTP/WebDAV, file sync or every application’s DNS behavior.',
        'Compare the affected application’s error and timestamps. Repeat this diagnosis immediately after the failure or wake event.');
    else if(!findings.length)add('connection_failed','One or more connection checks failed',
      'Refusal, timeout, an unavailable local network and TLS handshake failure remain separate outcomes.',
      'Inspect the failed address and port, then compare route, listener and firewall evidence.');
  }
  return findings;
}
