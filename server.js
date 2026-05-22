import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_FORMATS = new Set(['text', 'plain', 'raw', 'code', 'totp']);
const JSON_FORMATS = new Set(['json']);
const OTPAUTH_FORMATS = new Set(['otpauth', 'uri', 'url']);
const API_FORMATS = new Set([...TEXT_FORMATS, ...JSON_FORMATS, ...OTPAUTH_FORMATS]);
const ROOT = fileURLToPath(new URL('./public', import.meta.url));
const PORT = Number(process.env.PORT || 8787);

createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const format = resolveFormat(url.searchParams, req.headers['user-agent'] || '', req.headers.accept || '');

  if (format) {
    try {
      const record = parseRequestRecord(url.searchParams);
      const code = generateTotp(record.secret, record);
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

function resolveFormat(params, userAgent, accept) {
  const explicit = (params.get('format') || '').toLowerCase();
  if (API_FORMATS.has(explicit)) return explicit;
  if (explicit === 'html' || explicit === 'web' || explicit === 'page') return '';
  if (params.has('secret') || params.has('url') || params.has('otpauth') || params.has('otp')) {
    if (accept.includes('application/json')) return 'json';
    if (accept.includes('text/plain')) return 'text';
    if (/\b(curl|wget|httpie|python-requests|go-http-client|postmanruntime|insomnia)\b/i.test(userAgent)) return 'text';
  }
  return '';
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
  return 'application/octet-stream';
}

function parseRequestRecord(params) {
  const nested = params.get('url') || params.get('otpauth') || params.get('otp');
  if (nested) return parseInput(nested);
  const secret = params.get('secret');
  if (!secret) throw new Error('Missing secret or url parameter');
  return {
    label: params.get('label') || '',
    issuer: params.get('issuer') || '',
    secret,
    digits: Number(params.get('digits') || 6),
    period: Number(params.get('period') || 30),
    algorithm: params.get('algorithm') || 'SHA1'
  };
}

function parseInput(raw) {
  const text = safeDecode(String(raw || '').trim());
  if (!text) throw new Error('Empty input');

  if (text.toLowerCase().startsWith('otpauth://')) return parseOtpAuth(text);

  try {
    const url = new URL(text);
    const nested = url.searchParams.get('url') || url.searchParams.get('otpauth') || url.searchParams.get('otp');
    if (nested) return parseInput(nested);
    const secret = url.searchParams.get('secret');
    if (!secret) throw new Error('Missing secret or url parameter');
    return {
      label: url.searchParams.get('label') || '',
      issuer: url.searchParams.get('issuer') || '',
      secret,
      digits: Number(url.searchParams.get('digits') || 6),
      period: Number(url.searchParams.get('period') || 30),
      algorithm: url.searchParams.get('algorithm') || 'SHA1'
    };
  } catch {
    return { label: '', issuer: '', secret: text, digits: 6, period: 30, algorithm: 'SHA1' };
  }
}

function parseOtpAuth(raw) {
  const url = new URL(raw);
  const secret = url.searchParams.get('secret');
  if (!secret) throw new Error('otpauth URL missing secret');
  const labelRaw = safeDecode(url.pathname.replace(/^\/+/, ''));
  const issuerParam = url.searchParams.get('issuer') || '';
  let issuer = issuerParam;
  let label = labelRaw;
  if (labelRaw.includes(':')) {
    const parts = labelRaw.split(':');
    const prefix = parts.shift().trim();
    if (!issuer) issuer = prefix;
    if (issuer === prefix) label = parts.join(':').trim();
  }
  return {
    label,
    issuer,
    secret,
    digits: Number(url.searchParams.get('digits') || 6),
    period: Number(url.searchParams.get('period') || 30),
    algorithm: url.searchParams.get('algorithm') || 'SHA1'
  };
}

function generateTotp(secret, options = {}, time = Date.now()) {
  const period = normalizePeriod(options.period);
  const digits = normalizeDigits(options.digits);
  const algorithm = normalizeAlgorithm(options.algorithm);
  const counter = Math.floor(time / 1000 / period);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeUInt32BE(counter, 4);
  const hmac = createHmac(algorithm.toLowerCase().replace('sha', 'sha'), Buffer.from(base32Decode(secret)));
  const signature = hmac.update(counterBytes).digest();
  const offset = signature[signature.length - 1] & 0x0f;
  const binary = ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function base32Decode(secret) {
  const clean = normalizeSecret(secret);
  assertSecret(clean);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('Secret must be Base32');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return bytes;
}

function normalizeRecord(record) {
  const secret = normalizeSecret(record.secret);
  assertSecret(secret);
  return {
    label: record.label || '',
    issuer: record.issuer || '',
    secret,
    digits: normalizeDigits(record.digits),
    period: normalizePeriod(record.period),
    algorithm: normalizeAlgorithm(record.algorithm)
  };
}

function buildOtpAuth(record) {
  const issuerPrefix = record.issuer ? `${record.issuer}:` : '';
  const labelName = record.label || record.issuer || 'Secret';
  const label = encodeURIComponent(`${issuerPrefix}${labelName}`);
  const params = new URLSearchParams({
    secret: record.secret,
    issuer: record.issuer || '',
    algorithm: record.algorithm,
    digits: String(record.digits),
    period: String(record.period)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function normalizeSecret(secret) {
  return String(secret || '').toUpperCase().replace(/[\s=-]/g, '');
}

function assertSecret(secret) {
  if (!secret || secret.length < 8) throw new Error('Secret is too short');
  if (!/^[A-Z2-7]+$/.test(secret)) throw new Error('Secret must contain only Base32 characters A-Z and 2-7');
}

function normalizeDigits(value) {
  const digits = Number(value || 6);
  return [6, 7, 8].includes(digits) ? digits : 6;
}

function normalizePeriod(value) {
  const period = Number(value || 30);
  return Number.isFinite(period) && period >= 10 ? period : 30;
}

function normalizeAlgorithm(value) {
  const algorithm = String(value || 'SHA1').toUpperCase();
  return ['SHA1', 'SHA256', 'SHA512'].includes(algorithm) ? algorithm : 'SHA1';
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
