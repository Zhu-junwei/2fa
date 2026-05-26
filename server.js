import { webcrypto } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import './public/totp-core.js';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const {
  JSON_FORMATS,
  OTPAUTH_FORMATS,
  buildOtpAuth,
  generateTotp,
  normalizeRecord,
  parseRequestRecord,
  resolveFormat
} = globalThis.TotpCore;
const ROOT = fileURLToPath(new URL('./public', import.meta.url));
const PORT = Number(process.env.PORT || 8787);

createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const format = resolveRequestFormat(url, req.headers['user-agent'] || '', req.headers.accept || '');

  if (format) {
    try {
      const record = parseRequestRecord(url.searchParams);
      const code = await generateTotp(record.secret, record);
      sendFormatted(res, format, record, code);
    } catch (error) {
      sendError(res, format, error);
    }
    return;
  }

  await serveStatic(url.pathname, res);
}).listen(PORT, () => {
  console.log(`2FA TOTP server listening on http://127.0.0.1:${PORT}`);
});

function resolveRequestFormat(url, userAgent, accept) {
  return resolveFormat(url.searchParams, userAgent, accept) || (isApiPath(url.pathname) ? 'json' : '');
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function sendFormatted(res, format, record, code) {
  const normalized = normalizeRecord(record);
  if (JSON_FORMATS.has(format)) {
    const now = Date.now();
    const epoch = Math.floor(now / 1000);
    const remaining = normalized.period - (epoch % normalized.period);
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      code,
      remaining,
      period: normalized.period,
      digits: normalized.digits,
      algorithm: normalized.algorithm,
      secret: normalized.secret,
      issuer: normalized.issuer,
      label: normalized.label,
      otpauth: buildOtpAuth(normalized),
      generatedAt: new Date(now).toISOString(),
      validUntil: new Date((epoch + remaining) * 1000).toISOString()
    }));
    return;
  }

  if (OTPAUTH_FORMATS.has(format)) {
    send(res, 200, 'text/plain; charset=utf-8', buildOtpAuth(normalized));
    return;
  }

  send(res, 200, 'text/plain; charset=utf-8', code);
}

function sendError(res, format, error) {
  const message = error?.message || 'Invalid TOTP request';
  if (JSON_FORMATS.has(format)) {
    send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: message }));
    return;
  }
  send(res, 400, 'text/plain; charset=utf-8', message);
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(ROOT, safePath);

  try {
    const file = await stat(filePath);
    if (file.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    filePath = join(ROOT, 'index.html');
  }

  res.writeHead(200, {
    'content-type': contentType(filePath),
    'cache-control': 'no-store'
  });
  createReadStream(filePath).pipe(res);
}

function contentType(filePath) {
  const ext = extname(filePath);
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.webmanifest') return 'application/manifest+json; charset=utf-8';
  return 'application/octet-stream';
}
