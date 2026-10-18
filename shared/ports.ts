/** Common homelab TCP candidates, not verified application identities or UDP probes. */
export const COMMON_TCP_PORTS=[
  [22,'SSH'],[25,'SMTP'],[53,'DNS over TCP'],[80,'HTTP'],[111,'RPC portmapper'],[135,'Windows RPC'],[139,'NetBIOS session'],
  [389,'LDAP'],[443,'HTTPS'],[445,'SMB'],[548,'AFP'],[587,'Mail submission'],[631,'IPP'],[636,'LDAPS'],[873,'rsync'],
  [1433,'SQL Server'],[1883,'MQTT'],[2049,'NFS'],[2375,'Docker API'],[2376,'Docker TLS API'],[3000,'Grafana / web app'],
  [3306,'MySQL'],[3389,'Remote Desktop'],[5000,'NAS / web app'],[5001,'NAS TLS / web app'],[5432,'PostgreSQL'],
  [5672,'AMQP'],[5900,'VNC'],[5985,'WinRM'],[5986,'WinRM TLS'],[6379,'Redis'],[6443,'Kubernetes API'],
  [8006,'Proxmox UI/API'],[8080,'Alternate HTTP'],[8096,'Jellyfin'],[8123,'Home Assistant'],[8443,'Alternate HTTPS'],
  [8883,'MQTT TLS'],[8920,'Jellyfin TLS'],[9000,'Portainer / web app'],[9001,'Portainer agent'],[9090,'Prometheus / web app'],
  [9100,'Metrics / printer'],[9443,'Portainer TLS'],[27017,'MongoDB'],[32400,'Plex'],[61208,'Glances REST'],[61209,'Glances RPC'],
] as const;
export const COMMON_TCP_TEXT=COMMON_TCP_PORTS.map(([port])=>port).join(',');
export const portHint=(port:number)=>COMMON_TCP_PORTS.find(([value])=>value===port)?.[1]??'Custom TCP endpoint';
