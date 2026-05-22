const TEXT_FORMATS = new Set(['text', 'plain', 'raw', 'code', 'totp']);
const JSON_FORMATS = new Set(['json']);
const OTPAUTH_FORMATS = new Set(['otpauth', 'uri', 'url']);
const API_FORMATS = new Set([...TEXT_FORMATS, ...JSON_FORMATS, ...OTPAUTH_FORMATS]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const userAgent = request.headers.get('user-agent') || '';
    const accept = request.headers.get('accept') || '';
    const format = resolveFormat(url.searchParams, userAgent, accept);

    if (format) {
      try {
        const record = parseRequestRecord(url.searchParams);
        const code = await generateTotp(record.secret, record);
        return respondWithFormat(format, record, code);
      } catch (error) {
        return respondWithError(format, error);
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('2FA TOTP worker is running. Deploy with static assets to serve the web UI.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
};

function resolveFormat(params, userAgent, accept) {
  const explicit = (params.get('format') || '').toLowerCase();
  if (API_FORMATS.has(explicit)) return explicit;
  if (explicit === 'html' || explicit === 'web' || explicit === 'page') return '';
  if (params.has('secret') || params.has('url') || params.has('otpauth') || params.has('otp')) {
    if (accept.includes('application/json')) return 'json';
    if (accept.includes('text/plain')) return 'text';
    if (isCommandLine(userAgent)) return 'text';
  }
  return '';
}

function respondWithFormat(format, record, code) {
  const normalized = normalizeRecord(record);
  if (JSON_FORMATS.has(format)) {
    const now = Date.now();
    const epoch = Math.floor(now / 1000);
    const remaining = normalized.period - (epoch % normalized.period);
    return noStore(JSON.stringify({
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
    }), 'application/json; charset=utf-8');
  }

  if (OTPAUTH_FORMATS.has(format)) {
    return noStore(buildOtpAuth(normalized), 'text/plain; charset=utf-8');
  }

  return noStore(code, 'text/plain; charset=utf-8');
}

function respondWithError(format, error) {
  const message = error?.message || 'Invalid TOTP request';
  if (JSON_FORMATS.has(format)) {
    return noStore(JSON.stringify({ error: message }), 'application/json; charset=utf-8', 400);
  }
  return noStore(message, 'text/plain; charset=utf-8', 400);
}

function noStore(body, contentType, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store'
    }
  });
}

function isCommandLine(userAgent) {
  return /\b(curl|wget|httpie|python-requests|go-http-client|postmanruntime|insomnia)\b/i.test(userAgent);
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

  if (text.toLowerCase().startsWith('otpauth://')) {
    return parseOtpAuth(text);
  }

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
    return {
      secret: text,
      digits: 6,
      period: 30,
      algorithm: 'SHA1'
    };
  }
}

function parseOtpAuth(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid otpauth URL');
  }

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

async function generateTotp(secret, options = {}, time = Date.now()) {
  const period = normalizePeriod(options.period);
  const digits = normalizeDigits(options.digits);
  const algorithm = normalizeAlgorithm(options.algorithm);
  const counter = Math.floor(time / 1000 / period);
  const keyBytes = base32Decode(secret);
  const counterBytes = new ArrayBuffer(8);
  const view = new DataView(counterBytes);
  view.setUint32(4, counter, false);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: algorithm.replace('SHA', 'SHA-') }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));
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
  return new Uint8Array(bytes);
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
