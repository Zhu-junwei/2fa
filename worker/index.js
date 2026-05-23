import '../public/totp-core.js';

const {
  JSON_FORMATS,
  OTPAUTH_FORMATS,
  buildOtpAuth,
  generateTotp,
  normalizeRecord,
  parseRequestRecord,
  resolveFormat
} = globalThis.TotpCore;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const userAgent = request.headers.get('user-agent') || '';
    const accept = request.headers.get('accept') || '';
    const format = resolveRequestFormat(url, userAgent, accept);

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

function resolveRequestFormat(url, userAgent, accept) {
  return resolveFormat(url.searchParams, userAgent, accept) || (isApiPath(url.pathname) ? 'json' : '');
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
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
