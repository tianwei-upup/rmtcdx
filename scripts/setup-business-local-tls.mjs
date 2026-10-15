import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
const ip = process.argv[2];
if (net.isIP(ip) !== 4 || !(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip))) throw new Error('Provide a private LAN IPv4 address');
const root = path.resolve(import.meta.dirname, '..'), tls = path.join(root, '.runtime/business/tls');
fs.mkdirSync(tls, { recursive: true, mode: 0o700 });
const openssl = args => execFileSync('openssl', args, { cwd: tls, stdio: 'ignore' });
if (!fs.existsSync(path.join(tls, 'ca.pem'))) openssl(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30', '-subj', '/CN=Rmtagt Local Development CA']);
openssl(['req', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'server.key', '-out', 'server.csr', '-subj', `/CN=${ip}`]);
fs.writeFileSync(path.join(tls, 'server.ext'), `subjectAltName=IP:${ip},IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n`, { mode: 0o600 });
openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '14', '-extfile', 'server.ext']);
for (const file of fs.readdirSync(tls)) fs.chmodSync(path.join(tls, file), 0o600);
const resources = path.join(root, 'android/app/build/localTlsRes');
fs.mkdirSync(path.join(resources, 'raw'), { recursive: true }); fs.mkdirSync(path.join(resources, 'xml'), { recursive: true });
fs.copyFileSync(path.join(tls, 'ca.pem'), path.join(resources, 'raw/local_dev_ca.pem'));
fs.writeFileSync(path.join(resources, 'xml/network_security_config.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config>
  <domain-config cleartextTrafficPermitted="false"><domain includeSubdomains="false">${ip}</domain><trust-anchors><certificates src="@raw/local_dev_ca" /></trust-anchors></domain-config>
  <domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain><domain includeSubdomains="false">localhost</domain><domain includeSubdomains="false">10.0.2.2</domain></domain-config>
</network-security-config>\n`);
console.log(`Generated private development TLS and debug-only Android trust for ${ip}. No system CA or release resource changed.`);
