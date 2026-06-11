
const {
  buildOtpAuth,
  generateTotp,
  getRemainingSeconds,
  assertSecret,
  normalizeRecord,
  normalizeSecret,
  parseInput,
  recordKey
} = window.TotpCore;
const STORAGE_KEY = 'totp-records-v1';
const LANGUAGE_STORAGE_KEY = 'totp-language-v1';
const THEME_STORAGE_KEY = 'totp-theme-v1';
const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
const QR_CODE_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const SCAN_MAX_SIDE = 1280;
const IMAGE_QR_MAX_SIDE = 1800;
const LOCALES = window.TotpLocales;

const state = {
  records: [],
  activeId: null,
  locale: 'zh-CN',
  theme: 'light',
  codes: new Map(),
  toastTimer: null,
  raf: 0,
  renderedSecond: -1,
  editId: null,
  scanStream: null,
  scanRaf: 0,
  scanDetector: null,
  scanBusy: false,
  scanToken: 0,
  scanCanvas: null,
  scanCtx: null,
  manifestUrl: ''
};

const icons = window.TotpIcons;

const els = {
  input: document.getElementById('secretInput'),
  languageButton: document.getElementById('languageButton'),
  languageModal: document.getElementById('languageModal'),
  languageOptions: document.getElementById('languageOptions'),
  themeToggle: document.getElementById('themeToggle'),
  homeView: document.getElementById('homeView'),
  apiView: document.getElementById('apiView'),
  apiLink: document.getElementById('apiLink'),
  backHome: document.getElementById('backHome'),
  apiExamples: document.getElementById('apiExamples'),
  parseBtn: document.getElementById('parseBtn'),
  scanBtn: document.getElementById('scanBtn'),
  imageBtn: document.getElementById('imageBtn'),
  qrInput: document.getElementById('qrInput'),
  cameraInput: document.getElementById('cameraInput'),
  currentPanel: document.getElementById('currentPanel'),
  records: document.getElementById('records'),
  recordCount: document.getElementById('recordCount'),
  clearRecords: document.getElementById('clearRecords'),
  exportRecords: document.getElementById('exportRecords'),
  toast: document.getElementById('toast'),
  qrModal: document.getElementById('qrModal'),
  qrCanvas: document.getElementById('qrCanvas'),
  qrTitle: document.getElementById('qrTitle'),
  qrClose: document.getElementById('qrClose'),
  qrSecret: document.getElementById('qrSecret'),
  qrOtpAuth: document.getElementById('qrOtpAuth'),
  editModal: document.getElementById('editModal'),
  editForm: document.getElementById('editForm'),
  editClose: document.getElementById('editClose'),
  editCancel: document.getElementById('editCancel'),
  editLabel: document.getElementById('editLabel'),
  editIssuer: document.getElementById('editIssuer'),
  editSecret: document.getElementById('editSecret'),
  editDigits: document.getElementById('editDigits'),
  editPeriod: document.getElementById('editPeriod'),
  editAlgorithm: document.getElementById('editAlgorithm'),
  clearModal: document.getElementById('clearModal'),
  clearClose: document.getElementById('clearClose'),
  clearCancel: document.getElementById('clearCancel'),
  clearConfirm: document.getElementById('clearConfirm'),
  scanModal: document.getElementById('scanModal'),
  scanClose: document.getElementById('scanClose'),
  scanVideo: document.getElementById('scanVideo'),
  scanStatus: document.getElementById('scanStatus')
};

function detectLocale() {
  let saved = '';
  try {
    saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    saved = '';
  }
  if (saved && LOCALES[saved]) return saved;

  const available = Object.keys(LOCALES);
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
  for (const language of languages) {
    const normalized = normalizeLocale(language);
    if (LOCALES[normalized]) return normalized;
    const base = normalized.split('-')[0];
    const match = available.find((locale) => locale.split('-')[0] === base);
    if (match) return match;
  }

  return 'en-US';
}

function normalizeLocale(language) {
  return String(language || '')
    .replace('_', '-')
    .split('-')
    .map((part, index) => index === 0 ? part.toLowerCase() : part.toUpperCase())
    .join('-');
}

function t(key, params = {}) {
  const localeTexts = LOCALES[state.locale] || LOCALES['en-US'];
  let value = localeTexts[key];
  if (value === undefined && key.startsWith('close')) value = localeTexts.close;
  if (value === undefined) value = LOCALES['en-US'][key] ?? LOCALES['zh-CN'][key] ?? key;
  return typeof value === 'function' ? value(params) : value;
}

function setLanguage(locale, persist = false) {
  state.locale = LOCALES[locale] ? locale : detectLocale();
  document.documentElement.lang = state.locale;
  document.title = t('appTitle');
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', t('appTitle'));
  if (persist) {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, state.locale);
    } catch {
      // Ignore storage failures; the chosen language still applies for this session.
    }
  }
  applyStaticI18n();
  updateManifest();
}

function detectTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Ignore storage failures; the default light theme still applies.
  }
  return 'light';
}

function setTheme(theme, persist = false) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', state.theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getThemeColor());
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute(
    'content',
    state.theme === 'dark' ? 'black-translucent' : 'default'
  );
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, state.theme);
    } catch {
      showToast(t('localStorageFail'));
    }
  }
  updateThemeButton();
  updateManifest();
}

function getThemeColor() {
  return state.theme === 'dark' ? '#0d151b' : '#0f9f8f';
}

function getThemeBackgroundColor() {
  return state.theme === 'dark' ? '#0d151b' : '#f7f8fa';
}

function updateThemeButton() {
  if (!els.themeToggle) return;
  const label = state.theme === 'dark' ? t('switchToLight') : t('switchToDark');
  els.themeToggle.setAttribute('title', label);
  els.themeToggle.setAttribute('aria-label', label);
  els.themeToggle.dataset.mode = state.theme;
}

function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-attr]').forEach((node) => {
    node.dataset.i18nAttr.split(';').forEach((pair) => {
      const [attr, key] = pair.split(':').map((value) => value.trim());
      if (attr && key) node.setAttribute(attr, t(key));
    });
  });
  els.recordCount.textContent = t('recordCount', { count: state.records.length });
  renderLanguageOptions();
  updateThemeButton();
  if (!els.scanModal.classList.contains('open')) {
    els.scanStatus.textContent = t('scanStatusDefault');
  }
}

function updateManifest() {
  const manifest = {
    name: t('appTitle'),
    short_name: '2FA',
    description: t('appDescription'),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: getThemeBackgroundColor(),
    theme_color: getThemeColor(),
    lang: state.locale,
    icons: [
      { src: new URL('assets/images/icon-192.png', window.location.href).href, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: new URL('assets/images/icon-512.png', window.location.href).href, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  };
  const link = document.querySelector('link[rel="manifest"]');
  if (!link || typeof Blob !== 'function' || typeof URL.createObjectURL !== 'function') return;
  try {
    if (state.manifestUrl) URL.revokeObjectURL(state.manifestUrl);
    state.manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
    link.href = state.manifestUrl;
  } catch {
    // The static manifest remains available when blob URLs are restricted.
  }
}

function localizeError(error, fallbackKey) {
  const message = error?.message || '';
  const map = {
    'Web Crypto API is not available': 'webCryptoUnavailable',
    'Secret is too short': 'secretTooShort',
    'Secret must be Base32': 'secretBase32',
    'Secret must contain only Base32 characters A-Z and 2-7': 'secretBase32Chars',
    '没有识别到二维码': 'noQr',
    '图片读取失败': 'imageReadFailed',
    '脚本加载失败': 'scriptLoadFailed',
    '复制失败': 'copyFail'
  };
  return t(map[message] || fallbackKey);
}

init();

function init() {
  state.records = loadRecords();
  state.activeId = state.records[0]?.id || null;
  setTheme(detectTheme());
  setLanguage(detectLocale());
  bindEvents();
  importFromUrl();
  render();
  renderRoute();
  syncTicker();
}

function bindEvents() {
  els.apiLink.addEventListener('click', () => {
    window.location.hash = 'api';
  });
  els.languageButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (els.languageModal.classList.contains('open')) {
      closeLanguageModal();
    } else {
      openLanguageModal();
    }
  });
  els.languageModal.addEventListener('click', (event) => event.stopPropagation());
  els.languageOptions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-locale]');
    if (!button || !els.languageOptions.contains(button)) return;
    setLanguage(button.dataset.locale, true);
    closeLanguageModal();
    render();
    renderRoute();
  });
  els.themeToggle.addEventListener('click', () => {
    setTheme(state.theme === 'dark' ? 'light' : 'dark', true);
    els.themeToggle.blur();
  });
  els.backHome.addEventListener('click', () => {
    window.location.hash = '';
  });
  window.addEventListener('hashchange', renderRoute);
  els.parseBtn.addEventListener('click', () => addFromText(els.input.value));
  els.input.addEventListener('paste', handleInputPaste);
  els.input.addEventListener('keydown', handleInputKeydown);
  els.scanBtn.addEventListener('click', openScanModal);
  els.imageBtn.addEventListener('click', () => openFilePicker(els.qrInput));
  els.clearRecords.addEventListener('click', openClearModal);
  els.exportRecords.addEventListener('click', exportAllRecords);
  els.records.addEventListener('click', handleRecordClick);
  els.qrInput.addEventListener('change', handleQrUpload);
  els.cameraInput.addEventListener('change', handleQrUpload);
  els.scanClose.addEventListener('click', closeScanModal);
  els.scanModal.addEventListener('click', (event) => {
    if (event.target === els.scanModal) closeScanModal();
  });
  els.qrClose.addEventListener('click', closeQrModal);
  els.qrSecret.addEventListener('click', () => copyText(els.qrSecret.dataset.value || '').then(() => {
    flashCopied(els.qrSecret);
    showToast(t('copiedSecret'));
  }));
  els.qrOtpAuth.addEventListener('click', () => copyText(els.qrOtpAuth.dataset.value || '').then(() => showToast(t('copiedOtpAuth'))));
  els.qrModal.addEventListener('click', (event) => {
    if (event.target === els.qrModal) closeQrModal();
  });
  els.editClose.addEventListener('click', closeEditModal);
  els.editCancel.addEventListener('click', closeEditModal);
  els.editForm.addEventListener('submit', saveEditForm);
  els.editModal.addEventListener('click', (event) => {
    if (event.target === els.editModal) closeEditModal();
  });
  els.clearClose.addEventListener('click', closeClearModal);
  els.clearCancel.addEventListener('click', closeClearModal);
  els.clearConfirm.addEventListener('click', clearAllRecords);
  els.clearModal.addEventListener('click', (event) => {
    if (event.target === els.clearModal) closeClearModal();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) state.renderedSecond = -1;
    syncTicker();
  });
  window.addEventListener('resize', positionLanguageModal);
  window.addEventListener('scroll', positionLanguageModal, true);
  document.addEventListener('click', (event) => {
    if (!els.languageModal.classList.contains('open')) return;
    if (event.target === els.languageButton || els.languageButton.contains(event.target)) return;
    if (els.languageModal.contains(event.target)) return;
    closeLanguageModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeScanModal();
      closeQrModal();
      closeEditModal();
      closeClearModal();
      closeLanguageModal();
    }
  });
}

function openLanguageModal() {
  renderLanguageOptions();
  els.languageModal.classList.add('open');
  positionLanguageModal();
}

function closeLanguageModal() {
  els.languageModal.classList.remove('open');
}

function positionLanguageModal() {
  if (!els.languageModal || !els.languageButton || !els.languageModal.classList.contains('open')) return;
  const gap = 8;
  const margin = 12;
  const buttonRect = els.languageButton.getBoundingClientRect();
  const popoverRect = els.languageModal.getBoundingClientRect();
  const width = popoverRect.width || 180;
  const left = Math.min(
    Math.max(margin, buttonRect.right - width),
    window.innerWidth - width - margin
  );
  const top = Math.min(
    buttonRect.bottom + gap,
    window.innerHeight - popoverRect.height - margin
  );
  els.languageModal.style.left = `${left}px`;
  els.languageModal.style.top = `${Math.max(margin, top)}px`;
}

function renderLanguageOptions() {
  if (!els.languageOptions) return;
  els.languageOptions.innerHTML = Object.entries(LOCALES).map(([locale, texts]) => {
    const active = locale === state.locale;
    const nativeName = escapeHtml(texts.nativeName || locale);
    return `
      <button class="language-option${active ? ' active' : ''}" type="button" data-locale="${locale}" aria-pressed="${active}">
        <span>${nativeName}</span>
      </button>
    `;
  }).join('');
}

async function handleInputPaste(event) {
  const imageFile = getClipboardImageFile(event.clipboardData);
  if (imageFile) {
    event.preventDefault();
    await addFromQrImage(imageFile, t('noQrClipboard'));
    return;
  }

  const text = event.clipboardData?.getData('text') || '';
  try {
    if (splitBatchInput(text).length <= 1) return;
    event.preventDefault();
    addFromText(text);
  } catch {
    return;
  }
}

function handleInputKeydown(event) {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  addFromText(els.input.value);
}

async function animate() {
  if (document.hidden || !getActiveRecord()) {
    state.raf = 0;
    return;
  }

  const now = Date.now();
  const active = getActiveRecord();
  if (active) {
    const elapsed = (now / 1000) % active.period;
    const remaining = Math.max(0, active.period - elapsed);
    document.documentElement.style.setProperty('--progress', String(remaining / active.period));
    const second = Math.ceil(remaining);
    const timerText = document.getElementById('timerText');
    if (timerText) timerText.textContent = `${String(second).padStart(2, '0')}s`;

    const wholeSecond = Math.floor(now / 1000);
    if (wholeSecond !== state.renderedSecond) {
      state.renderedSecond = wholeSecond;
      await refreshCodes(now);
      updateDynamicCodeViews(now);
    }
  }

  if (document.hidden || !getActiveRecord()) {
    state.raf = 0;
    return;
  }
  state.raf = requestAnimationFrame(animate);
}

function startTicker() {
  if (state.raf || document.hidden || !getActiveRecord()) return;
  state.raf = requestAnimationFrame(animate);
}

function stopTicker() {
  if (!state.raf) return;
  cancelAnimationFrame(state.raf);
  state.raf = 0;
}

function syncTicker() {
  if (document.hidden || !getActiveRecord()) {
    stopTicker();
  } else {
    startTicker();
  }
}

async function refreshCodes(now = Date.now()) {
  await Promise.all(state.records.map(async (record) => {
    try {
      const code = await generateTotp(record.secret, record, now);
      state.codes.set(record.id, code);
    } catch {
      state.codes.set(record.id, t('errorCode'));
    }
  }));
}

function updateDynamicCodeViews(now = Date.now()) {
  const active = getActiveRecord();
  if (active) {
    const currentCard = els.currentPanel.querySelector('.current-card');
    currentCard?.classList.toggle('urgent', getRemainingSeconds(active, now) <= 5);

    const currentCode = els.currentPanel.querySelector('.totp-code[data-action="copy-code"]');
    if (currentCode) {
      currentCode.textContent = state.codes.get(active.id) || ''.padStart(active.digits || 6, '·');
    }
  }

  els.records.querySelectorAll('.record').forEach((recordEl) => {
    const codeButton = recordEl.querySelector('.mini-code[data-action="copy-code"]');
    const record = state.records.find((item) => item.id === codeButton?.dataset.id);
    if (!record || !codeButton) return;

    recordEl.classList.toggle('urgent', getRemainingSeconds(record, now) <= 5);
    codeButton.textContent = state.codes.get(record.id) || ''.padStart(record.digits || 6, '·');
  });
}

function addFromText(raw) {
  try {
    const inputs = splitBatchInput(raw);
    let successCount = 0;
    const errors = [];

    inputs.forEach((input) => {
      try {
        saveRecord(parseInput(input), { render: false });
        successCount += 1;
      } catch (error) {
        errors.push(error);
      }
    });

    if (!successCount) {
      throw errors[0] || new Error(t('noParse'));
    }

    els.input.value = '';
    persistRecords();
    render();

    if (inputs.length === 1) {
      showToast(t('parsed'));
    } else if (errors.length) {
      showToast(t('parsedPartial', { success: successCount, failed: errors.length }));
    } else {
      showToast(t('parsedCount', { count: successCount }));
    }
  } catch (error) {
    showToast(localizeError(error, 'noParse'));
  }
}

function splitBatchInput(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error(t('enterSecret'));

  const otpAuthMatches = text.match(/otpauth:\/\/\S+/gi);
  if (otpAuthMatches?.length > 1) {
    return otpAuthMatches.map(cleanBatchItem);
  }

  const lines = text
    .split(/\r?\n/)
    .map(cleanBatchItem)
    .filter(Boolean);

  return lines.length ? lines : [text];
}

function cleanBatchItem(value) {
  return String(value || '')
    .trim()
    .replace(/^[\s>*-]*\d+[.)、]\s*/, '')
    .replace(/^[\s>*-]+/, '')
    .replace(/[，,;；]+$/, '')
    .trim();
}

function saveRecord(record, options = {}) {
  const normalized = {
    ...normalizeRecord(record),
    id: record.id || crypto.randomUUID(),
    addedAt: record.addedAt || new Date().toISOString()
  };

  const key = recordKey(normalized);
  const existingIndex = state.records.findIndex((item) => recordKey(item) === key);
  if (existingIndex >= 0) {
    normalized.id = state.records[existingIndex].id;
    normalized.addedAt = state.records[existingIndex].addedAt;
    state.records.splice(existingIndex, 1, normalized);
  } else {
    state.records.unshift(normalized);
  }

  state.activeId = normalized.id;
  state.renderedSecond = -1;
  if (options.render !== false) {
    persistRecords();
    render();
  }
}

function deleteRecord(id) {
  state.records = state.records.filter((item) => item.id !== id);
  if (state.activeId === id) state.activeId = state.records[0]?.id || null;
  state.codes.delete(id);
  persistRecords();
  render();
  showToast(t('deleted'));
}

function setActive(id) {
  state.activeId = id;
  state.renderedSecond = -1;
  render();
}

function render() {
  renderCurrent();
  renderRecords();
  els.recordCount.textContent = t('recordCount', { count: state.records.length });
  els.clearRecords.disabled = !state.records.length;
  els.exportRecords.hidden = !state.records.length;
  if (!state.records.length) closeClearModal();
  syncTicker();
}

function openClearModal() {
  if (!state.records.length) return;
  els.clearModal.classList.add('open');
}

function closeClearModal() {
  els.clearModal.classList.remove('open');
}

function clearAllRecords() {
  if (!state.records.length) return;
  state.records = [];
  state.activeId = null;
  state.codes.clear();
  state.renderedSecond = -1;
  persistRecords();
  closeClearModal();
  render();
  showToast(t('cleared'));
}

function exportAllRecords() {
  if (!state.records.length) {
    showToast(t('noExport'));
    return;
  }

  const content = state.records.map(buildOtpAuth).join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `2fa-totp-${formatExportTimestamp()}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(t('exported', { count: state.records.length }));
}

function formatExportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function renderRoute() {
  const apiMode = window.location.hash === '#api';
  els.homeView.classList.toggle('hidden', apiMode);
  els.apiView.classList.toggle('active', apiMode);
  if (apiMode) {
    renderApiExamples();
  } else {
    els.apiExamples.innerHTML = '';
  }
}

function renderApiExamples() {
  const apiBase = window.location.protocol === 'file:'
    ? 'https://your-domain.example/api'
    : new URL('/api', window.location.origin).toString();
  const secret = 'JBSWY3DPEHPK3PXP';
  const otpAuth = 'otpauth://totp/Demo?secret=JBSWY3DPEHPK3PXP&issuer=Demo';
  const textUrl = `${apiBase}?secret=${encodeURIComponent(secret)}&format=text`;
  const jsonUrl = `${apiBase}?secret=${encodeURIComponent(secret)}&format=json`;
  const otpAuthUrl = `${apiBase}?url=${encodeURIComponent(otpAuth)}&format=otpauth`;
  const autoTextUrl = `${apiBase}?secret=${encodeURIComponent(secret)}`;
  const acceptJsonUrl = `${apiBase}?secret=${encodeURIComponent(secret)}`;
  const curlSecret = `curl "${textUrl}"`;
  const curlJson = `curl "${jsonUrl}"`;
  const curlOtpAuth = `curl "${otpAuthUrl}"`;
  const curlAutoText = `curl "${autoTextUrl}"`;
  const curlAcceptJson = `curl -H "Accept: application/json" "${acceptJsonUrl}"`;
  const fetchExample = `const code = await fetch("${textUrl}")\n  .then((res) => res.text());\nconsole.log(code);`;

  els.apiExamples.innerHTML = `
    <div class="api-card">
      <h3>format=text</h3>
      <p>${t('apiTextDesc')}</p>
      ${renderCodeBox(curlSecret)}
    </div>
    <div class="api-card">
      <h3>format=json</h3>
      <p>${t('apiJsonDesc')}</p>
      ${renderCodeBox(curlJson)}
    </div>
    <div class="api-card">
      <h3>format=otpauth</h3>
      <p>${t('apiOtpAuthDesc')}</p>
      ${renderCodeBox(curlOtpAuth)}
    </div>
    <div class="api-card">
      <h3>${t('apiDefaultTitle')}</h3>
      <p>${t('apiDefaultDesc')}</p>
      ${renderCodeBox(curlAutoText)}
    </div>
    <div class="api-card">
      <h3>${t('apiAcceptTitle')}</h3>
      <p>${t('apiAcceptDesc')}</p>
      ${renderCodeBox(curlAcceptJson)}
    </div>
    <div class="api-card">
      <h3>${t('apiFetchTitle')}</h3>
      <p>${t('apiFetchDesc')}</p>
      ${renderCodeBox(fetchExample)}
    </div>
  `;
  els.apiExamples.querySelectorAll('[data-api-copy]').forEach((button) => {
    button.addEventListener('click', () => copyText(button.dataset.apiCopy || '').then(() => showToast(t('copiedExample'))));
  });
}

function renderCodeBox(code) {
  return `
    <div class="code-box">
      <pre>${escapeHtml(code)}</pre>
      <button class="icon-btn" type="button" data-api-copy="${escapeHtml(code)}" title="${t('copyExample')}" aria-label="${t('copyExample')}">${icons.copy}</button>
    </div>
  `;
}

function renderIdentityHtml(record) {
  const parts = [];
  if (record.label) parts.push(`<strong>${escapeHtml(record.label)}</strong>`);
  if (record.issuer) parts.push(`<span>${escapeHtml(record.issuer)}</span>`);
  if (!parts.length) return '';
  return `<div class="identity">${parts.join('')}</div>`;
}

function buildDisplayName(record) {
  return [record.issuer, record.label].filter(Boolean).join(' · ');
}

function renderCurrent() {
  const active = getActiveRecord();
  if (!active) {
    els.currentPanel.innerHTML = `<div class="empty">${t('emptyState')}</div>`;
    return;
  }

  const code = state.codes.get(active.id) || ''.padStart(active.digits || 6, '·');
  const identityHtml = renderIdentityHtml(active);
  const otpAuth = buildOtpAuth(active);
  const urgentClass = getRemainingSeconds(active) <= 5 ? ' urgent' : '';
  els.currentPanel.innerHTML = `
    <div class="current-card${urgentClass}">
      <div class="meta-line">
        <div class="info-stack">
          ${identityHtml}
        </div>
        <div class="quick-actions">
          <button class="icon-btn" type="button" data-action="edit" data-id="${active.id}" title="${t('edit')}" aria-label="${t('edit')}">${icons.edit}</button>
          <button class="icon-btn" type="button" data-action="share" data-id="${active.id}" title="${t('copyShare')}" aria-label="${t('copyShare')}">${icons.share}</button>
          <button class="icon-btn" type="button" data-action="qr" data-id="${active.id}" title="${t('showQr')}" aria-label="${t('showQr')}">${icons.qr}</button>
        </div>
      </div>
      <div class="code-row">
        <button class="totp-code" type="button" data-action="copy-code" data-id="${active.id}" title="${t('copyCode')}">${escapeHtml(code)}</button>
        <div class="timer">
          <div class="timer-top"><span>${t('remaining')}</span><strong id="timerText">--s</strong></div>
          <div class="bar"><div class="bar-fill"></div></div>
          <div class="hint">${t('timerHint', { digits: active.digits, period: active.period, algorithm: escapeHtml(active.algorithm) })}</div>
        </div>
      </div>
      <div class="credential-lines">
        <div class="credential-line">
          <span class="credential-label">Secret</span>
          <button class="credential-value" type="button" data-action="copy-secret" data-id="${active.id}" title="${t('copySecret')}">${escapeHtml(active.secret)}</button>
        </div>
        <div class="credential-line">
          <span class="credential-label">otpauth</span>
          <button class="credential-value" type="button" data-action="copy-otpauth" data-id="${active.id}" title="${t('copyOtpAuth')}">${escapeHtml(otpAuth)}</button>
        </div>
      </div>
    </div>
  `;
  els.currentPanel.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', handleRecordAction);
  });
}

function renderRecords() {
  if (!state.records.length) {
    els.records.innerHTML = '';
    return;
  }

  els.records.innerHTML = state.records.map((record) => {
    const code = state.codes.get(record.id) || ''.padStart(record.digits || 6, '·');
    const activeClass = record.id === state.activeId ? ' active' : '';
    const urgentClass = getRemainingSeconds(record) <= 5 ? ' urgent' : '';
    const identityHtml = renderIdentityHtml(record);
    return `
      <article class="record${activeClass}${urgentClass}" data-record-id="${record.id}" title="${t('switchCurrent')}">
        <div class="record-info">
          ${identityHtml ? `<button class="record-title" type="button" data-action="activate" data-id="${record.id}" title="${t('switchCurrent')}">${identityHtml}</button>` : ''}
          <button class="record-secret" type="button" data-action="copy-secret" data-id="${record.id}" title="${t('copySecret')}">${escapeHtml(record.secret)}</button>
        </div>
        <button class="mini-code" type="button" data-action="copy-code" data-id="${record.id}" title="${t('copyCode')}">${escapeHtml(code)}</button>
        <div class="record-actions">
          <button class="icon-btn" type="button" data-action="edit" data-id="${record.id}" title="${t('edit')}" aria-label="${t('edit')}">${icons.edit}</button>
          <button class="icon-btn" type="button" data-action="share" data-id="${record.id}" title="${t('copyShare')}" aria-label="${t('copyShare')}">${icons.share}</button>
          <button class="icon-btn" type="button" data-action="qr" data-id="${record.id}" title="${t('showQr')}" aria-label="${t('showQr')}">${icons.qr}</button>
          <button class="icon-btn danger" type="button" data-action="delete" data-id="${record.id}" title="${t('delete')}" aria-label="${t('delete')}">${icons.trash}</button>
        </div>
      </article>
    `;
  }).join('');

  els.records.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', handleRecordAction);
  });
}

function handleRecordClick(event) {
  if (event.target.closest('[data-action]')) return;

  const recordEl = event.target.closest('.record[data-record-id]');
  if (!recordEl || !els.records.contains(recordEl)) return;

  setActive(recordEl.dataset.recordId);
}

function handleRecordAction(event) {
  const button = event.currentTarget;
  event.preventDefault();
  button.blur();
  const action = button.dataset.action;
  const id = button.dataset.id;
  const record = state.records.find((item) => item.id === id);
  if (!record) return;

  if (action === 'activate') {
    setActive(id);
    return;
  }
  if (action === 'copy-code') {
    copyText(state.codes.get(id) || '').then(() => showToast(t('copiedCode')));
    return;
  }
  if (action === 'copy-secret') {
    copyText(record.secret).then(() => {
      flashCopied(button);
      showToast(t('copiedSecret'));
    });
    return;
  }
  if (action === 'copy-otpauth') {
    copyText(buildOtpAuth(record)).then(() => {
      flashCopied(button);
      showToast(t('copiedOtpAuth'));
    });
    return;
  }
  if (action === 'edit') {
    openEditModal(record);
    return;
  }
  if (action === 'share') {
    copyText(buildShareLink(record)).then(() => showToast(t('shareCopied')));
    return;
  }
  if (action === 'qr') {
    openQrModal(record);
    return;
  }
  if (action === 'delete') {
    deleteRecord(id);
  }
}

function importFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const incoming = params.get('url') || params.get('otpauth') || params.get('otp') || params.get('secret');
  if (!incoming) return;
  try {
    saveRecord(parseInput(incoming, params));
    const clean = `${window.location.pathname}${window.location.hash || ''}`;
    window.history.replaceState({}, '', clean);
    showToast(t('importedUrl'));
  } catch (error) {
    showToast(localizeError(error, 'urlInvalid'));
  }
}

async function handleQrUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await addFromQrImage(file, t('noQr'));
  } finally {
    event.target.value = '';
  }
}

async function addFromQrImage(file, fallbackMessage) {
  try {
    const content = await decodeQrFromImage(file);
    addFromText(content);
  } catch (error) {
    showToast(error.message || fallbackMessage || t('noQr'));
  }
}

function getClipboardImageFile(clipboardData) {
  const items = Array.from(clipboardData?.items || []);
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && (file.type.startsWith('image/') || item.type.startsWith('image/'))) {
      return file;
    }
  }

  return Array.from(clipboardData?.files || []).find((file) => file.type.startsWith('image/')) || null;
}

async function openScanModal() {
  if (!canUseLiveCamera()) {
    if (shouldUseCameraCaptureFallback()) {
      openCameraCapture(t('noCameraLive'));
    } else {
      showToast(t('cameraHttps'));
    }
    return;
  }

  try {
    const token = state.scanToken + 1;
    state.scanToken = token;
    els.scanStatus.textContent = t('openingCamera');
    els.scanModal.classList.add('open');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' }
      },
      audio: false
    });
    if (token !== state.scanToken || !els.scanModal.classList.contains('open')) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    state.scanStream = stream;
    els.scanVideo.srcObject = stream;
    await els.scanVideo.play();
    els.scanStatus.textContent = t('scanPlace');
    scanVideoFrame();
  } catch (error) {
    closeScanModal();
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      showToast(t('cameraDenied'));
    } else if (shouldUseCameraCaptureFallback()) {
      openCameraCapture(t('scanFallback'));
    } else {
      showToast(t('cameraOpenFailed'));
    }
  }
}

function canUseLiveCamera() {
  return Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
}

function shouldUseCameraCaptureFallback() {
  const ua = navigator.userAgent || navigator.vendor || '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua));
  return Boolean(isMobile && els.cameraInput);
}

function openCameraCapture(message = t('cameraCapture')) {
  showToast(message);
  openFilePicker(els.cameraInput);
}

function openFilePicker(input) {
  input.value = '';
  input.click();
}

function closeScanModal() {
  state.scanToken += 1;
  if (state.scanRaf) {
    cancelAnimationFrame(state.scanRaf);
    state.scanRaf = 0;
  }
  if (state.scanStream) {
    state.scanStream.getTracks().forEach((track) => track.stop());
    state.scanStream = null;
  }
  state.scanDetector = null;
  state.scanBusy = false;
  releaseScanCanvas();
  els.scanVideo.pause();
  els.scanVideo.srcObject = null;
  els.scanVideo.removeAttribute('src');
  els.scanVideo.load();
  els.scanStatus.textContent = t('scanStatusDefault');
  els.scanModal.classList.remove('open');
}

async function scanVideoFrame() {
  if (!state.scanStream) {
    state.scanRaf = 0;
    return;
  }

  if (state.scanBusy) {
    state.scanRaf = requestAnimationFrame(scanVideoFrame);
    return;
  }

  if (!els.scanVideo.videoWidth || !els.scanVideo.videoHeight) {
    state.scanRaf = requestAnimationFrame(scanVideoFrame);
    return;
  }

  state.scanBusy = true;
  try {
    const content = await decodeQrFromVideo(els.scanVideo);
    if (content) {
      closeScanModal();
      addFromText(content);
      return;
    }
  } catch {
    els.scanStatus.textContent = t('recognizing');
  } finally {
    state.scanBusy = false;
  }

  if (state.scanStream) {
    state.scanRaf = requestAnimationFrame(scanVideoFrame);
  }
}

async function decodeQrFromImage(file) {
  const source = await loadImageSource(file);
  let canvas = null;
  try {
    const scale = Math.min(1, IMAGE_QR_MAX_SIDE / Math.max(source.width, source.height));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source.image, 0, 0, canvas.width, canvas.height);
    return await decodeQrFromCanvas(canvas);
  } finally {
    source.close?.();
    releaseCanvas(canvas);
  }
}

function getScanCanvas(width, height) {
  const targetWidth = Math.max(1, Math.round(width));
  const targetHeight = Math.max(1, Math.round(height));
  if (!state.scanCanvas) {
    state.scanCanvas = document.createElement('canvas');
  }
  if (state.scanCanvas.width !== targetWidth || state.scanCanvas.height !== targetHeight) {
    state.scanCanvas.width = targetWidth;
    state.scanCanvas.height = targetHeight;
    state.scanCtx = null;
  }
  state.scanCtx ||= state.scanCanvas.getContext('2d', { willReadFrequently: true });
  return state.scanCanvas;
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function releaseScanCanvas() {
  releaseCanvas(state.scanCanvas);
  state.scanCanvas = null;
  state.scanCtx = null;
}

async function decodeQrFromVideo(video) {
  const scale = Math.min(1, SCAN_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = getScanCanvas(video.videoWidth * scale, video.videoHeight * scale);
  state.scanCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return decodeQrFromCanvas(canvas);
}

async function decodeQrFromCanvas(canvas) {
  if (!canvas?.width || !canvas?.height) throw new Error(t('noQr'));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if ('BarcodeDetector' in window) {
    try {
      const detector = state.scanDetector || new BarcodeDetector({ formats: ['qr_code'] });
      state.scanDetector = detector;
      const results = await detector.detect(canvas);
      if (results[0]?.rawValue) return results[0].rawValue;
    } catch {
      state.scanDetector = null;
    }
  }

  await ensureJsQr();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = window.jsQR(imageData.data, imageData.width, imageData.height);
  if (result?.data) return result.data;
  throw new Error(t('noQr'));
}

async function loadImageSource(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close?.()
      };
    } catch {
      // Fall through to HTMLImageElement for mobile browser compatibility.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(t('imageReadFailed')));
      img.src = url;
    });
    return {
      image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      close: () => URL.revokeObjectURL(url)
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function ensureJsQr() {
  if (window.jsQR) return Promise.resolve();
  return loadScript(JSQR_URL, () => window.jsQR);
}

function openEditModal(record) {
  state.editId = record.id;
  els.editLabel.value = record.label || '';
  els.editIssuer.value = record.issuer || '';
  els.editSecret.value = record.secret || '';
  els.editDigits.value = String(record.digits || 6);
  els.editPeriod.value = String(record.period || 30);
  els.editAlgorithm.value = record.algorithm || 'SHA1';
  els.editModal.classList.add('open');
  els.editSecret.focus();
}

function closeEditModal() {
  state.editId = null;
  els.editModal.classList.remove('open');
}

function saveEditForm(event) {
  event.preventDefault();
  const record = state.records.find((item) => item.id === state.editId);
  if (!record) return;

  const updated = {
    ...record,
    label: els.editLabel.value.trim(),
    issuer: els.editIssuer.value.trim(),
    secret: normalizeSecret(els.editSecret.value),
    digits: Number(els.editDigits.value || 6),
    period: Number(els.editPeriod.value || 30),
    algorithm: (els.editAlgorithm.value || 'SHA1').toUpperCase()
  };

  try {
    assertSecret(updated.secret);
  } catch (error) {
    showToast(localizeError(error, 'secretInvalid'));
    return;
  }

  if (![6, 7, 8].includes(updated.digits)) updated.digits = 6;
  if (!Number.isFinite(updated.period) || updated.period < 10) updated.period = 30;
  if (!['SHA1', 'SHA256', 'SHA512'].includes(updated.algorithm)) updated.algorithm = 'SHA1';

  state.records = state.records.map((item) => item.id === updated.id ? updated : item);
  state.activeId = updated.id;
  state.renderedSecond = -1;
  persistRecords();
  closeEditModal();
  render();
  showToast(t('saved'));
}

async function openQrModal(record) {
  try {
    await ensureQrCode();
    const otpAuth = buildOtpAuth(record);
    els.qrTitle.textContent = buildDisplayName(record) || 'Secret';
    els.qrSecret.dataset.value = record.secret;
    els.qrOtpAuth.dataset.value = otpAuth;
    els.qrSecret.querySelector('code').textContent = record.secret;
    els.qrOtpAuth.querySelector('code').textContent = otpAuth;
    drawQrToCanvas(els.qrCanvas, otpAuth);
    els.qrModal.classList.add('open');
  } catch (error) {
    showToast(localizeError(error, 'qrGenerateFailed'));
  }
}

function closeQrModal() {
  els.qrModal.classList.remove('open');
}

function ensureQrCode() {
  if (window.qrcode) return Promise.resolve();
  return loadScript(QR_CODE_URL, () => window.qrcode);
}

function drawQrToCanvas(canvas, text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = Math.min(canvas.width, canvas.height);
  const quiet = 4;
  const moduleSize = Math.floor(size / (count + quiet * 2));
  const totalSize = moduleSize * (count + quiet * 2);
  const startX = Math.floor((canvas.width - totalSize) / 2) + quiet * moduleSize;
  const startY = Math.floor((canvas.height - totalSize) / 2) + quiet * moduleSize;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111827';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(
          startX + col * moduleSize,
          startY + row * moduleSize,
          moduleSize,
          moduleSize
        );
      }
    }
  }
}

function loadScript(src, ready) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => ready() ? resolve() : reject(new Error(t('scriptLoadFailed'))), { once: true });
      existing.addEventListener('error', () => reject(new Error(t('scriptLoadFailed'))), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => ready() ? resolve() : reject(new Error(t('scriptLoadFailed')));
    script.onerror = () => reject(new Error(t('scriptLoadFailed')));
    document.head.appendChild(script);
  });
}

function buildShareLink(record) {
  const base = window.location.protocol === 'file:'
    ? window.location.href.split('?')[0].split('#')[0]
    : `${window.location.origin}${window.location.pathname}`;
  return `${base}?url=${encodeURIComponent(buildOtpAuth(record))}`;
}

function loadRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const json = utf8FromBase64(raw);
    const records = JSON.parse(json);
    if (!Array.isArray(records)) return [];
    return records.map((record) => ({ ...record, secret: normalizeSecret(record.secret) })).filter((record) => {
      try {
        assertSecret(record.secret);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function persistRecords() {
  try {
    localStorage.setItem(STORAGE_KEY, base64FromUtf8(JSON.stringify(state.records)));
  } catch {
    showToast(t('localStorageFail'));
  }
}

function getActiveRecord() {
  return state.records.find((item) => item.id === state.activeId) || state.records[0] || null;
}

async function copyText(text) {
  if (!text) return;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      window.getSelection()?.removeAllRanges();
      return;
    } catch {
      // Fall back to the selection-based copy path when browser permissions deny clipboard access.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  window.getSelection()?.removeAllRanges();
  textarea.remove();
  if (!copied) throw new Error(t('copyFail'));
}

function flashCopied(element) {
  element.classList.add('copied');
  window.setTimeout(() => element.classList.remove('copied'), 900);
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('show');
  state.toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 1800);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function base64FromUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary);
}

function utf8FromBase64(text) {
  const binary = atob(text);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
