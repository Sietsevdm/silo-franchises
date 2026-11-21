import { lookup } from 'node:dns/promises';
import { request as https } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { AppError } from './providers.mjs';

const blocked = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked.addSubnet(network, bits, 'ipv4');

export function publicArtworkUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError(400, 'Enter a direct public HTTPS image URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)\.?$/i.test(url.hostname) || isIP(url.hostname)) {
    throw new AppError(400, 'Enter a direct public HTTPS image URL.');
  }
  return url;
}

export async function downloadPublicArtwork(value) {
  const url = publicArtworkUrl(value);
  let addresses;
  try { addresses = await lookup(url.hostname, { all: true, family: 4 }); }
  catch { throw new AppError(422, 'The custom artwork hostname could not be resolved.'); }
  if (!addresses.length || addresses.some(({ address }) => blocked.check(address, 'ipv4'))) {
    throw new AppError(400, 'Custom artwork URLs must resolve to public addresses.');
  }
  const [{ address, family }] = addresses;
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(15_000);
    const req = https(url, { signal, agent: false, family,
      lookup: (_host, options, done) => options.all ? done(null, [{ address, family }]) : done(null, address, family),
    }, async (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new AppError(422, 'The custom artwork URL must return an image directly.'));
        return;
      }
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of response) {
          size += chunk.length;
          if (size > 15 * 1024 * 1024) throw new AppError(413, 'The custom artwork is larger than 15 MB.');
          chunks.push(chunk);
        }
        resolve(Buffer.concat(chunks, size));
      } catch (error) {
        reject(error instanceof AppError ? error : new AppError(422, 'Could not read the custom artwork.'));
      }
    });
    req.on('error', () => reject(new AppError(422, 'Could not download the custom artwork over HTTPS.')));
    req.end();
  });
}
