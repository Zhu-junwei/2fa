(function (global) {
  const TEXT_FORMATS = new Set(['text', 'plain', 'raw', 'code', 'totp']);
  const JSON_FORMATS = new Set(['json']);
  const OTPAUTH_FORMATS = new Set(['otpauth', 'uri', 'url']);
  const API_FORMATS = new Set([...TEXT_FORMATS, ...JSON_FORMATS, ...OTPAUTH_FORMATS]);

  function resolveFormat(params, userAgent = '', accept = '') {
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

  function isCommandLine(userAgent) {
    return /\b(curl|wget|httpie|python-requests|go-http-client|postmanruntime|insomnia)\b/i.test(userAgent);
  }

  function parseRequestRecord(params) {
    const nested = params.get('url') || params.get('otpauth') || params.get('otp');
    if (nested) return parseInput(nested);

    const secret = params.get('secret');
    if (!secret) throw new Error('Missing secret or url parameter');
    return {
      label: params.get('label') || params.get('account') || '',
      issuer: params.get('issuer') || '',
      secret,
      digits: Number(params.get('digits') || 6),
      period: Number(params.get('period') || 30),
      algorithm: params.get('algorithm') || 'SHA1'
    };
  }

  function parseInput(raw, extraParams = null) {
    const text = String(raw || '').trim();
    if (!text) throw new Error('Empty input');
    const decodedText = safeDecode(text);

    if (decodedText.toLowerCase().startsWith('otpauth://')) {
      return parseOtpAuth(decodedText);
    }

    const urlRecord = parseUrlLike(decodedText);
    if (urlRecord) return urlRecord;

    const params = extraParams || parseSearchParams(decodedText);
    if (params) {
      const nested = params.get('url') || params.get('otpauth') || params.get('otp');
      if (nested) return parseInput(nested);
      const secret = params.get('secret');
      if (secret) {
        return {
          label: params.get('label') || params.get('account') || '',
          issuer: params.get('issuer') || '',
          secret,
          digits: Number(params.get('digits') || 6),
          period: Number(params.get('period') || 30),
          algorithm: params.get('algorithm') || 'SHA1'
        };
      }
    }

    return {
      label: '',
      issuer: '',
      secret: decodedText,
      digits: 6,
      period: 30,
      algorithm: 'SHA1'
    };
  }

  function parseUrlLike(text) {
    try {
      const url = new URL(text);
      const nested = url.searchParams.get('url') || url.searchParams.get('otpauth') || url.searchParams.get('otp');
      if (nested) return parseInput(nested);
      const secret = url.searchParams.get('secret');
      if (!secret) return null;
      return {
        label: url.searchParams.get('label') || url.searchParams.get('account') || '',
        issuer: url.searchParams.get('issuer') || '',
        secret,
        digits: Number(url.searchParams.get('digits') || 6),
        period: Number(url.searchParams.get('period') || 30),
        algorithm: url.searchParams.get('algorithm') || 'SHA1'
      };
    } catch {
      return null;
    }
  }

  function parseSearchParams(text) {
    const trimmed = String(text || '').replace(/^\?/, '');
    if (!trimmed.includes('=')) return null;
    return new URLSearchParams(trimmed);
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

    const labelRaw = safeDecode(url.pathname.replace(/^\/+/, '')) || 'TOTP';
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
      label: label || issuer || 'TOTP',
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
    const normalized = normalizeRecord(record);
    const issuerPrefix = normalized.issuer ? `${normalized.issuer}:` : '';
    const labelName = normalized.label || normalized.issuer || 'Secret';
    const label = encodeURIComponent(`${issuerPrefix}${labelName}`);
    const params = new URLSearchParams({
      secret: normalized.secret,
      issuer: normalized.issuer || '',
      algorithm: normalized.algorithm,
      digits: String(normalized.digits),
      period: String(normalized.period)
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

    const subtle = await getSubtleCrypto();
    const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: algorithm.replace('SHA', 'SHA-') }, false, ['sign']);
    const signature = new Uint8Array(await subtle.sign('HMAC', key, counterBytes));
    const offset = signature[signature.length - 1] & 0x0f;
    const binary = ((signature[offset] & 0x7f) << 24) |
      ((signature[offset + 1] & 0xff) << 16) |
      ((signature[offset + 2] & 0xff) << 8) |
      (signature[offset + 3] & 0xff);
    return String(binary % (10 ** digits)).padStart(digits, '0');
  }

  async function getSubtleCrypto() {
    if (global.crypto?.subtle) return global.crypto.subtle;
    throw new Error('Web Crypto API is not available');
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

  function recordKey(record) {
    return `${normalizeSecret(record.secret)}|${record.issuer || ''}|${record.label || ''}`;
  }

  function getRemainingSeconds(record, time = Date.now()) {
    const period = normalizePeriod(record?.period);
    const elapsed = (time / 1000) % period;
    return Math.ceil(Math.max(0, period - elapsed));
  }

  function safeDecode(text) {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  }

  global.TotpCore = {
    TEXT_FORMATS,
    JSON_FORMATS,
    OTPAUTH_FORMATS,
    API_FORMATS,
    resolveFormat,
    parseRequestRecord,
    parseInput,
    parseOtpAuth,
    normalizeRecord,
    buildOtpAuth,
    generateTotp,
    normalizeSecret,
    assertSecret,
    normalizeDigits,
    normalizePeriod,
    normalizeAlgorithm,
    recordKey,
    getRemainingSeconds
  };
})(globalThis);
