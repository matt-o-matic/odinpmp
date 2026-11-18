import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['100::', 64], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(network, prefix, 'ipv6');

function isPublic(address) { const family = isIP(address); return Boolean(family) && !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6'); }

export async function postPublicWebhook({ body, headers = {}, resolveHostname = dnsLookup, timeoutMs = 10_000, url }) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new Error('Webhook delivery requires a public HTTPS endpoint on the standard port.');
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('Webhook endpoint resolves to a non-public host.');
  const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolveHostname(hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => !isPublic(String(record.address)))) throw new Error('Webhook endpoint resolves to a non-public address.');
  return new Promise((resolve, reject) => {
    const request = https.request(parsed, {
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      lookup(_hostname, _options, callback) { callback(null, records[0].address, records[0].family); },
      method: 'POST',
      servername: hostname,
    }, (response) => {
      let received = 0;
      response.on('data', (chunk) => { received += chunk.length; if (received > 64 * 1024) response.destroy(new Error('Webhook response exceeded 64 KiB.')); });
      response.on('end', () => resolve({ status: Number(response.statusCode ?? 0) }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Webhook request timed out.')));
    request.on('error', reject); request.end(body);
  });
}
