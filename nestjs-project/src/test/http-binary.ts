import { request as httpRequest, type IncomingMessage } from 'http';
import { URL } from 'url';

function readHeader(
  headers: NodeJS.Dict<string | string[]>,
  name: string,
): string | null {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

export function putBinary(
  url: string,
  body: Buffer,
): Promise<{ status: number; etag: string | null }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'PUT',
        headers: { 'content-length': body.length },
      },
      (res: IncomingMessage) => {
        res.resume();
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            etag: readHeader(res.headers, 'etag'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export function getRange(
  url: string,
  range: string,
): Promise<{ status: number; contentRange: string | null; length: number }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { Range: range },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            contentRange: readHeader(res.headers, 'content-range'),
            length: Buffer.concat(chunks).length,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
