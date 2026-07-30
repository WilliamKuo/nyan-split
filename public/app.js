import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { getLocale, t, toggleLocale } from './i18n.js';
import JSZip from './vendor/jszip.mjs';
import QRCode from './vendor/qrcode.mjs';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const google = new GoogleAuthProvider();
const root = document.querySelector('#root');
const loadingOverlay = document.querySelector('#loading-overlay');
const settingsReference = doc(db, 'settings', 'app');

const DEFAULT_CURRENCY = 'TWD';
const EXCHANGE_RATE_URL = 'https://open.er-api.com/v6/latest/';
const SETTLEMENT_EPSILON = 0.005;
const IMAGE_MAX_DIMENSION = 1600;
const IMAGE_MIN_DIMENSION = 480;
const IMAGE_MAX_BYTES = 500 * 1024;
const BATCH_DELETE_LIMIT = 400;
const MAX_LEDGER_SPLITS = 12;
const MAX_LEDGER_NOTE_LENGTH = 12;
const MAX_LEDGER_AMOUNT_INTEGER_DIGITS = 10;
const MAX_LEDGER_AMOUNT = 10 ** MAX_LEDGER_AMOUNT_INTEGER_DIGITS - 0.01;
const NEW_LEDGER_ENTRY_IMAGE_KEY = 'new-entry';
const GOOGLE_PROVIDER_ID = 'google.com';
const BACKUP_FORMAT = 'nyan-split-ledger-backup';
const BACKUP_VERSION = 2;
const BACKUP_SUPPORTED_VERSIONS = [
  1,
  BACKUP_VERSION,
];
const BACKUP_ENTRY_NAME = 'nyan-split-ledger-backup.json';
const BACKUP_ZIP_STORE_MAGIC = '\x00\x00';
const BACKUP_ZIP_DEFLATE_MAGIC = '\x08\x00';
const BACKUP_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const BACKUP_MAX_JSON_BYTES = 128 * 1024 * 1024;
const BACKUP_MAX_RECORDS = 100000;
const BACKUP_MAX_DOCUMENTS_PER_TRANSACTION = 4;
const BACKUP_MAX_TRANSACTION_BYTES = 7 * 1024 * 1024;
const BACKUP_MAX_DOCUMENT_ID_BYTES = 1500;
const BACKUP_MIN_TIMESTAMP_SECONDS = -62135596800;
const BACKUP_MAX_TIMESTAMP_SECONDS = 253402300799;
const BACKUP_MIN_TIMESTAMP_MILLIS = -62135596800000;
const BACKUP_MAX_TIMESTAMP_MILLIS = 253402300799999;
const BACKUP_IMAGE_MAX_CHARACTERS = 700000;
const BACKUP_COLLECTIONS = [
  'ledger',
  'ledgerSplits',
  'ledgerImages',
];
const BACKUP_TIMESTAMP_FIELDS = {
  ledger: [
    'createdAt',
    'updatedAt',
  ],
  ledgerImages: [
    'createdAt',
  ],
  ledgerSplits: [
    'createdAt',
    'updatedAt',
  ],
};
const BACKUP_COLLECTION_LABEL_KEYS = {
  ledger: 'backupExpensesLabel',
  ledgerImages: 'backupImagesLabel',
  ledgerSplits: 'backupDebtsLabel',
};
const JPEG_QUALITIES = [
  .78,
  .68,
  .58,
  .48,
];
const DEFAULT_ALLOWED_CURRENCIES = [
  'TWD',
];
const LEDGER_USER_STATUSES = [
  'active',
  'removed',
];
const CURRENCY_SUGGESTIONS = [
  ['AUD', 'Australian dollar'],
  ['CAD', 'Canadian dollar'],
  ['CHF', 'Swiss franc'],
  ['CNY', 'Chinese yuan'],
  ['EUR', 'Euro'],
  ['GBP', 'British pound'],
  ['HKD', 'Hong Kong dollar'],
  ['IDR', 'Indonesian rupiah'],
  ['INR', 'Indian rupee'],
  ['JPY', 'Japanese yen'],
  ['KRW', 'South Korean won'],
  ['MYR', 'Malaysian ringgit'],
  ['NZD', 'New Zealand dollar'],
  ['PHP', 'Philippine peso'],
  ['SGD', 'Singapore dollar'],
  ['THB', 'Thai baht'],
  ['TWD', 'New Taiwan dollar'],
  ['USD', 'US dollar'],
  ['VND', 'Vietnamese dong'],
];

let authUser = null;
let profile = null;
let settings = defaultSettings();
let adminCurrencySettings = null;
let ledgerEntries = [];
let ledgerSplits = [];
let ledgerEntriesReady = false;
let ledgerSplitsReady = false;
let ledgerFilter = '';
let ledgerCollapsed = localStorage.getItem('nyan-split-ledger-collapsed') === 'true';

function loadLedgerExpandedFooters() {
  try {
    const stored = JSON.parse(localStorage.getItem('nyan-split-ledger-footer-expanded') || '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistLedgerExpandedFooters() {
  localStorage.setItem(
    'nyan-split-ledger-footer-expanded',
    JSON.stringify([...ledgerExpandedFooters]),
  );
}

let ledgerExpandedFooters = loadLedgerExpandedFooters();
let adminShowAllUsers = localStorage.getItem('nyan-split-admin-show-all-users') === 'true';
let ledgerImages = new Map();
let selectableUsers = [];
let knownUsers = [];
let managedUsers = [];
let googleVerifiedUserIds = new Set();
let calculatedSettlements = null;
let notice = '';
let noticeType = 'info';
let activeView = 'ledger';
let pendingResultCurrency = '';
let pendingCurrencyRateDraft = null;
let selectedLedgerImageEntryId = '';
let selectedLedgerImageIndex = 0;
let editingLedgerEntryId = '';
let ledgerEditDraft = null;
let ledgerNewDraft = null;
let nextLedgerSplitDraftId = 0;
let isClearingLedgerData = false;
let isClearingRemovedUsers = false;
let pendingLedgerImageFocus = null;
let seedingCurrencyRates = false;
let initialCurrencyRatesSeeded = false;
let appVersion = '';
let showHelpGuide = false;
let backupStatus = '';
let backupStatusType = 'info';
let isBackupBusy = false;

let stopProfile;
let stopSettings;
let stopLedger;
let stopLedgerSplits;
let stopLedgerImages;
let stopUsers;
let stopUserAuth;
let deferredInstallPrompt = null;
let appInstalled = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

const usdRates = new Map([['USD', 1]]);
const rateRequests = new Map();
const unavailablePublicRates = new Set();
const pendingLedgerEntryImages = new Map();

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (authUser && isActiveUser(profile) && activeView === 'share') render();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  appInstalled = true;
  render();
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[character]));
}

function cleanAlias(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function normalizeCurrency(value) {
  const currency = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : '';
}

function ledgerNoteCharacterCount(note) {
  return [...String(note || '')].length;
}

function normalizeLedgerNote(note) {
  const trimmed = String(note || '').trim();
  return [...trimmed].slice(0, MAX_LEDGER_NOTE_LENGTH).join('');
}

function ledgerAmountIntegerDigitCount(amount) {
  const value = Math.trunc(Math.abs(Number(amount)));
  if (!Number.isFinite(value) || value === 0) return 0;
  return value.toString().length;
}

function isValidLedgerAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return false;
  return ledgerAmountIntegerDigitCount(value) <= MAX_LEDGER_AMOUNT_INTEGER_DIGITS;
}

const LEDGER_AMOUNT_EXPRESSION_PATTERN = /^[\d+\-*/().\s]+$/;

function tokenizeLedgerAmountExpression(expression) {
  const tokens = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if ('+-*/()'.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (/\d/.test(char) || char === '.') {
      let number = '';
      while (index < expression.length && /[\d.]/.test(expression[index])) {
        number += expression[index];
        index += 1;
      }
      if (!/^\d+(\.\d+)?$/.test(number) && !/^\.\d+$/.test(number)) return null;
      tokens.push(Number(number));
      continue;
    }
    return null;
  }
  return tokens;
}

function evaluateLedgerAmountExpression(expression) {
  const trimmed = String(expression || '').trim();
  if (!trimmed || !LEDGER_AMOUNT_EXPRESSION_PATTERN.test(trimmed)) return null;

  const tokens = tokenizeLedgerAmountExpression(trimmed);
  if (!tokens?.length) return null;

  let position = 0;

  const peek = () => tokens[position];
  const consume = () => tokens[position++];

  const parsePrimary = () => {
    const token = peek();
    if (token === '(') {
      consume();
      const value = parseExpression();
      if (consume() !== ')') throw new Error('syntax');
      return value;
    }
    if (typeof token === 'number') {
      consume();
      return token;
    }
    throw new Error('syntax');
  };

  const parseUnary = () => {
    if (peek() === '+') {
      consume();
      return parseUnary();
    }
    if (peek() === '-') {
      consume();
      return -parseUnary();
    }
    return parsePrimary();
  };

  const parseTerm = () => {
    let value = parseUnary();
    while (peek() === '*' || peek() === '/') {
      const operator = consume();
      const right = parseUnary();
      if (operator === '/') {
        if (right === 0) throw new Error('divide-by-zero');
        value /= right;
      } else {
        value *= right;
      }
    }
    return value;
  };

  function parseExpression() {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const operator = consume();
      const right = parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  try {
    const result = parseExpression();
    if (position !== tokens.length || !Number.isFinite(result)) return null;
    return result;
  } catch {
    return null;
  }
}

function parseLedgerAmountInput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  return evaluateLedgerAmountExpression(trimmed);
}

function roundLedgerAmount(value) {
  return Math.round(value * 100) / 100;
}

function formatParsedLedgerAmount(value) {
  return roundLedgerAmount(value).toFixed(2).replace(/\.?0+$/, '');
}

function resolveLedgerAmountInput(raw) {
  const parsed = parseLedgerAmountInput(raw);
  return parsed === null ? NaN : roundLedgerAmount(parsed);
}

function normalizeLedgerAmountField(input) {
  if (!(input instanceof HTMLInputElement)) return;

  const previous = input.dataset.ledgerAmountPrevious ?? input.value;
  const trimmed = String(input.value || '').trim();
  if (!trimmed) {
    input.value = previous;
    return;
  }

  const parsed = parseLedgerAmountInput(trimmed);
  const rounded = parsed === null ? null : roundLedgerAmount(parsed);
  if (rounded === null || !isValidLedgerAmount(rounded)) {
    input.value = previous;
    return;
  }

  const formatted = formatParsedLedgerAmount(rounded);
  input.value = formatted;
  input.dataset.ledgerAmountPrevious = formatted;
}

function normalizeLedgerFormAmountFields(form) {
  form?.querySelectorAll('.entry-amount-field [name="amount"]').forEach((input) => {
    normalizeLedgerAmountField(input);
  });
}

function bindLedgerAmountInputs(root = document) {
  root?.querySelectorAll('.entry-amount-field [name="amount"]').forEach((input) => {
    if (input.dataset.ledgerAmountBound === '1') return;
    input.dataset.ledgerAmountBound = '1';
    input.addEventListener('focus', () => {
      input.dataset.ledgerAmountPrevious = input.value;
    });
    input.addEventListener('blur', () => {
      normalizeLedgerAmountField(input);
      const form = input.closest('form');
      if (form?.id === 'ledger-form') captureLedgerNewDraft(form);
      if (form?.id === 'ledger-edit-form') captureLedgerEditDraft(form);
    });
  });
}

function normalizeAllowedCurrencies(currencies) {
  const knownCurrencies = new Set();
  return (Array.isArray(currencies) ? currencies : []).reduce((result, currency) => {
    const normalizedCurrency = normalizeCurrency(currency);
    if (!normalizedCurrency || knownCurrencies.has(normalizedCurrency)) return result;
    knownCurrencies.add(normalizedCurrency);
    result.push(normalizedCurrency);
    return result;
  }, []);
}

function defaultSettings() {
  return {
    defaultCurrency: DEFAULT_CURRENCY,
    allowedCurrencies: [...DEFAULT_ALLOWED_CURRENCIES],
  };
}

function normalizeSettings(value) {
  const configuredCurrencies = normalizeAllowedCurrencies(value?.allowedCurrencies);
  const allowedCurrencies = configuredCurrencies.length
    ? configuredCurrencies
    : [...DEFAULT_ALLOWED_CURRENCIES];
  const configuredDefault = normalizeCurrency(value?.defaultCurrency);
  const defaultCurrency = allowedCurrencies.includes(configuredDefault)
    ? configuredDefault
    : allowedCurrencies.includes(DEFAULT_CURRENCY)
      ? DEFAULT_CURRENCY
      : allowedCurrencies[0];

  return {
    defaultCurrency,
    allowedCurrencies,
  };
}

function currentAdminCurrencySettings() {
  const source = adminCurrencySettings || settings;
  return {
    defaultCurrency: source.defaultCurrency,
    allowedCurrencies: [...source.allowedCurrencies],
  };
}

function isAllowedCurrency(value) {
  return settings.allowedCurrencies.includes(normalizeCurrency(value));
}

function findUsedLedgerCurrency(currencies, entries = ledgerEntries) {
  const normalizedCurrencies = new Set(
    currencies.map((currency) => normalizeCurrency(currency)),
  );
  const usedEntry = entries.find((entry) => (
    normalizedCurrencies.has(normalizeCurrency(entry.currency))
  ));
  return usedEntry ? normalizeCurrency(usedEntry.currency) : '';
}

function defaultAlias() {
  return cleanAlias(authUser?.displayName)
    || authUser?.email?.split('@')[0]
    || t('newUser');
}

function authUserHasGoogleIdentity(user = authUser) {
  return Boolean(user?.providerData?.some(
    (provider) => provider.providerId === GOOGLE_PROVIDER_ID,
  ));
}

function isEnabledUser(user) {
  return user?.disabled !== true;
}

function isActiveUser(user) {
  return user?.status === 'active' && isEnabledUser(user);
}

function isSelectableLedgerUser(user) {
  return isActiveUser(user) && user.ledgerSelectable !== false;
}

function currentUserIsAdmin() {
  return Boolean(
    authUser
    && profile?.uid === authUser.uid
    && isActiveUser(profile)
    && profile.role === 'admin'
    && authUserHasGoogleIdentity(authUser),
  );
}

function userHasVerifiedGoogleIdentity(userId) {
  return googleVerifiedUserIds.has(userId)
    || (userId === authUser?.uid && authUserHasGoogleIdentity(authUser));
}

function userAlias(user) {
  return user?.alias || user?.name || user?.email?.split('@')[0] || t('unknownUser');
}

function knownUserById(userId) {
  return knownUsers.find((user) => user.id === userId) || null;
}

function selectableUserById(userId) {
  return selectableUsers.find((user) => user.id === userId) || null;
}

function userPhotoUrl(user) {
  const photoURL = user?.photoURL
    || (user?.uid === authUser?.uid ? authUser?.photoURL : '');
  return String(photoURL || '').trim();
}

function renderUserAvatar(user) {
  const photoURL = userPhotoUrl(user);
  if (photoURL) {
    return `<img class="avatar-image" src="${escapeHtml(photoURL)}" alt="" />`;
  }
  return `<span class="avatar" aria-hidden="true">${escapeHtml(userAlias(user).slice(0, 1).toUpperCase())}</span>`;
}

function profileCurrency() {
  const resultCurrency = normalizeCurrency(
    profile?.resultCurrency || profile?.preferredCurrency,
  );
  return isAllowedCurrency(resultCurrency)
    ? resultCurrency
    : settings.defaultCurrency;
}

function selectedResultCurrency() {
  const resultCurrency = normalizeCurrency(pendingResultCurrency);
  return isAllowedCurrency(resultCurrency)
    ? resultCurrency
    : profileCurrency();
}

function relativeRate(sourceUsdRate, resultUsdRate) {
  if (!Number.isFinite(sourceUsdRate) || sourceUsdRate <= 0) return null;
  if (!Number.isFinite(resultUsdRate) || resultUsdRate <= 0) return null;
  return sourceUsdRate / resultUsdRate;
}

function isPositiveRate(value) {
  return Number.isFinite(value) && value > 0;
}

function personalResultRates(resultCurrency) {
  const storedRates = profile?.currencyRates;
  if (
    resultCurrency !== profileCurrency()
    || !storedRates
    || typeof storedRates !== 'object'
    || Array.isArray(storedRates)
  ) {
    return {};
  }

  return settings.allowedCurrencies.reduce((rates, currency) => {
    const rate = Number(storedRates[currency]);
    if (currency !== resultCurrency && isPositiveRate(rate)) {
      rates[currency] = rate;
    }
    return rates;
  }, {});
}

function publicResultRate(currency, resultCurrency) {
  if (currency === resultCurrency) return 1;
  return relativeRate(usdRates.get(currency), usdRates.get(resultCurrency));
}

function publicResultRateUnavailable(currency, resultCurrency) {
  return [currency, resultCurrency].some(
    (item) => item !== 'USD' && unavailablePublicRates.has(item),
  );
}

function captureCurrencyRateDraft(form) {
  const resultCurrency = normalizeCurrency(form?.elements.resultCurrency?.value);
  if (!isAllowedCurrency(resultCurrency)) return;

  const rates = {};
  settings.allowedCurrencies.forEach((currency) => {
    if (currency === resultCurrency) return;
    rates[currency] = String(
      form.elements[`currencyRate-${currency}`]?.value || '',
    ).trim();
  });
  pendingCurrencyRateDraft = {
    rates,
    resultCurrency,
  };
}

function requestPublicResultRate(currency, resultCurrency) {
  if (
    currency !== resultCurrency
    && !usdRates.has(currency)
    && !unavailablePublicRates.has(currency)
  ) {
    void fetchUsdRate(currency).then(render).catch(render);
  }
  if (!usdRates.has(resultCurrency) && !unavailablePublicRates.has(resultCurrency)) {
    void fetchUsdRate(resultCurrency).then(render).catch(render);
  }
}

function resultRate(currency, resultCurrency) {
  const sourceCurrency = normalizeCurrency(currency);
  if (!sourceCurrency) return null;
  if (sourceCurrency === resultCurrency) return 1;

  const personalRate = personalResultRates(resultCurrency)[sourceCurrency];
  if (isPositiveRate(personalRate)) return personalRate;

  requestPublicResultRate(sourceCurrency, resultCurrency);
  return publicResultRate(sourceCurrency, resultCurrency);
}

function amountInResultCurrency(amountValue, currency, resultCurrency) {
  const amount = Number(amountValue);
  const sourceCurrency = normalizeCurrency(currency) || DEFAULT_CURRENCY;
  const rate = resultRate(sourceCurrency, resultCurrency);
  if (!Number.isFinite(amount) || amount <= 0 || !isPositiveRate(rate)) return null;
  return amount * rate;
}

function clearCalculatedSettlements() {
  calculatedSettlements = null;
}

function unavailableLedgerRateCurrencies(resultCurrency) {
  const unavailableCurrencies = new Set();

  ledgerEntries.forEach((entry) => {
    const hasUnclearedSplit = ledgerSplitsForEntry(entry.id)
      .some((split) => !split.cleared);
    if (!hasUnclearedSplit) return;

    const sourceCurrency = normalizeCurrency(entry.currency) || DEFAULT_CURRENCY;
    if (
      sourceCurrency !== resultCurrency
      && !isPositiveRate(resultRate(sourceCurrency, resultCurrency))
      && publicResultRateUnavailable(sourceCurrency, resultCurrency)
    ) {
      unavailableCurrencies.add(sourceCurrency);
    }
  });

  return [...unavailableCurrencies].sort();
}

function formatRate(rate) {
  return new Intl.NumberFormat(getLocale() === 'zh' ? 'zh-Hant' : 'en', {
    maximumFractionDigits: 8,
  }).format(rate);
}

function formatMoney(amount, currency = profileCurrency()) {
  try {
    return new Intl.NumberFormat(getLocale() === 'zh' ? 'zh-Hant' : 'en', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${Number(amount || 0).toFixed(2)} ${currency}`;
  }
}

function createdAtValue(entry) {
  return entry.createdAt?.toMillis?.() || 0;
}

function setNotice(message = '', type = 'info') {
  notice = message;
  noticeType = type;
  render();
}

function setErrorNotice(message) {
  setNotice(message, 'error');
}

function reportError(error) {
  console.error(error);
  setErrorNotice(t('operationFailed'));
}

function listenerError(context) {
  return (error) => {
    finishInitialLoading();
    reportError(new Error(`${context}: ${error.message}`));
  };
}

function brand() {
  return `<div class="brand">
    <button class="brand-mark" aria-label="${escapeHtml(t('shareInstall'))}" data-view="share">🌈🐱</button>
    <div>
      <h1>NyanSplit</h1>
      <p>${escapeHtml(t('tagline'))}</p>
    </div>
  </div>`;
}

function themeToggleLabel() {
  return document.documentElement.dataset.theme === 'dark'
    ? t('light')
    : t('dark');
}

function preferenceControls() {
  return `<div class="preference-controls" aria-label="${escapeHtml(t('displayPreferences'))}">
    <button class="text-button preference-button" type="button" data-action="locale">${escapeHtml(t('language'))}</button>
    <button class="text-button preference-button" type="button" data-action="theme">${escapeHtml(themeToggleLabel())}</button>
  </div>`;
}

function authFrame(content) {
  return `<main class="auth-shell">
    <section class="auth-card">
      ${preferenceControls()}
      ${brand()}
      ${notice ? `<p class="notice notice-${noticeType}" role="${noticeType === 'error' ? 'alert' : 'status'}">${escapeHtml(notice)}</p>` : ''}
      ${content}
    </section>
  </main>`;
}

function renderCurrencyOptions(selectedCurrency, currencies = settings.allowedCurrencies) {
  return currencies.map((currency) => (
    `<option value="${currency}"${currency === selectedCurrency ? ' selected' : ''}>${currency}</option>`
  )).join('');
}

function renderCurrencySuggestions() {
  return CURRENCY_SUGGESTIONS.map(([currency, name]) => (
    `<option value="${currency}" label="${escapeHtml(name)}"></option>`
  )).join('');
}

function renderAllowedCurrencyChips(currencies, defaultCurrency) {
  return currencies.map((currency) => {
    const isDefault = currency === defaultCurrency;
    return `<span class="currency-chip">
      <span>${escapeHtml(currency)}</span>
      ${isDefault
        ? `<span class="currency-default">${escapeHtml(t('default'))}</span>`
        : `<button type="button" data-remove-allowed-currency="${escapeHtml(currency)}" aria-label="${escapeHtml(t('removeCurrency', { currency }))}">×</button>`}
    </span>`;
  }).join('');
}

function renderRegistration() {
  root.innerHTML = authFrame(`
    <h2>${escapeHtml(t('registration'))}</h2>
    <p class="muted">${escapeHtml(t('aliasHelp'))}</p>
    <form id="registration-form" class="stack-form">
      <label class="field">
        <span>${escapeHtml(t('alias'))}</span>
        <input name="alias" maxlength="40" value="${escapeHtml(defaultAlias())}" autocomplete="nickname" />
      </label>
      <button type="submit">${escapeHtml(t('register'))}</button>
    </form>
    <button class="text-button" type="button" data-action="signout">${escapeHtml(t('signOut'))}</button>
  `);
  bind();
  finishInitialLoading();
}

function renderPending() {
  const statusContent = profile.disabled === true
    ? {
      heading: t('disabled'),
      text: t('disabledText'),
    }
    : {
      rejected: {
        heading: t('rejected'),
        text: t('rejectedText'),
      },
      removed: {
        heading: t('removed'),
        text: t('removedText'),
      },
    }[profile.status] || {
      heading: t('pending'),
      text: t('pendingText'),
    };
  root.innerHTML = authFrame(`
    <p class="eyebrow">${escapeHtml(userAlias(profile))}</p>
    <h2>${escapeHtml(statusContent.heading)}</h2>
    <p class="muted">${escapeHtml(statusContent.text)}</p>
    <button class="text-button" type="button" data-action="signout">${escapeHtml(t('signOut'))}</button>
  `);
  bind();
  finishInitialLoading();
}

function calculateBalances() {
  const resultCurrency = profileCurrency();
  const balances = new Map();
  ledgerEntries.forEach((entry) => {
    ledgerSplitsForEntry(entry.id).forEach((split) => {
      if (split.cleared) return;
      const amount = amountInResultCurrency(
        split.amount,
        entry.currency,
        resultCurrency,
      );
      const debtorId = split.debtorId;
      const creditorId = entry.creditorId;
      if (
        !Number.isFinite(amount)
        || amount <= 0
        || !debtorId
        || !creditorId
        || debtorId === creditorId
      ) return;
      balances.set(creditorId, (balances.get(creditorId) || 0) + amount);
      balances.set(debtorId, (balances.get(debtorId) || 0) - amount);
    });
  });
  return balances;
}

function calculateSettlementPlan() {
  const balances = [...calculateBalances()]
    .filter(([, amount]) => Math.abs(amount) > SETTLEMENT_EPSILON)
    .map(([userId, amount]) => ({
      amount,
      userId,
    }));
  let bestSettlements = null;

  const settle = (settlements) => {
    if (bestSettlements && settlements.length >= bestSettlements.length) return;

    const unsettledIndex = balances.findIndex((balance) => (
      Math.abs(balance.amount) > SETTLEMENT_EPSILON
    ));
    if (unsettledIndex === -1) {
      bestSettlements = [...settlements];
      return;
    }

    const unsettled = balances[unsettledIndex];
    const unsettledOwes = unsettled.amount < -SETTLEMENT_EPSILON;
    const triedAmounts = [];

    for (let candidateIndex = 0; candidateIndex < balances.length; candidateIndex += 1) {
      if (candidateIndex === unsettledIndex) continue;
      const candidate = balances[candidateIndex];
      const candidateCanSettle = unsettledOwes
        ? candidate.amount > SETTLEMENT_EPSILON
        : candidate.amount < -SETTLEMENT_EPSILON;
      if (!candidateCanSettle) continue;
      if (triedAmounts.some((amount) => (
        Math.abs(amount - candidate.amount) <= SETTLEMENT_EPSILON
      ))) continue;
      triedAmounts.push(candidate.amount);

      const amount = Math.min(Math.abs(unsettled.amount), Math.abs(candidate.amount));
      const settlement = unsettledOwes
        ? {
          amount,
          debtorId: unsettled.userId,
          creditorId: candidate.userId,
        }
        : {
          amount,
          debtorId: candidate.userId,
          creditorId: unsettled.userId,
        };
      const unsettledAmount = unsettled.amount;
      const candidateAmount = candidate.amount;
      const nextUnsettledAmount = unsettledAmount + (unsettledOwes ? amount : -amount);
      const nextCandidateAmount = candidateAmount + (unsettledOwes ? -amount : amount);

      unsettled.amount = Math.abs(nextUnsettledAmount) <= SETTLEMENT_EPSILON
        ? 0
        : nextUnsettledAmount;
      candidate.amount = Math.abs(nextCandidateAmount) <= SETTLEMENT_EPSILON
        ? 0
        : nextCandidateAmount;
      settlements.push(settlement);
      settle(settlements);
      settlements.pop();
      unsettled.amount = unsettledAmount;
      candidate.amount = candidateAmount;

      if (Math.abs(nextUnsettledAmount) <= SETTLEMENT_EPSILON
          && Math.abs(nextCandidateAmount) <= SETTLEMENT_EPSILON) break;
    }
  };

  settle([]);
  return bestSettlements || [];
}

function calculateSuggestedTransfers() {
  calculatedSettlements = calculateSettlementPlan();
  render();
}

async function fetchUsdRate(currency, forceRefresh = false) {
  if (currency === 'USD') return 1;
  if (!forceRefresh && usdRates.has(currency)) return usdRates.get(currency);
  if (rateRequests.has(currency)) return rateRequests.get(currency);

  const request = fetch(`${EXCHANGE_RATE_URL}${encodeURIComponent(currency)}`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Exchange-rate request failed (${response.status}).`);
      const data = await response.json();
      const rate = Number(data?.rates?.USD);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`No USD exchange rate was returned for ${currency}.`);
      }
      usdRates.set(currency, rate);
      unavailablePublicRates.delete(currency);
      clearCalculatedSettlements();
      return rate;
    })
    .catch((error) => {
      unavailablePublicRates.add(currency);
      clearCalculatedSettlements();
      throw error;
    })
    .finally(() => rateRequests.delete(currency));

  rateRequests.set(currency, request);
  return request;
}

function ensureCurrencyRateDraft(resultCurrency) {
  if (pendingCurrencyRateDraft?.resultCurrency === resultCurrency) return;

  const personalRates = personalResultRates(resultCurrency);
  const rates = {};
  const form = document.querySelector('#currency-conversion-form');

  settings.allowedCurrencies.forEach((currency) => {
    if (currency === resultCurrency) return;
    const input = form?.elements[`currencyRate-${currency}`];
    if (input) {
      rates[currency] = String(input.value || '').trim();
      return;
    }
    const savedRate = personalRates[currency];
    rates[currency] = isPositiveRate(savedRate) ? formatRate(savedRate) : '';
  });

  pendingCurrencyRateDraft = {
    rates,
    resultCurrency,
  };
}

async function refreshPublicRateForCurrency(currency) {
  const normalizedCurrency = normalizeCurrency(currency);
  const resultCurrency = selectedResultCurrency();
  if (
    !isAllowedCurrency(normalizedCurrency)
    || normalizedCurrency === resultCurrency
  ) {
    return;
  }

  try {
    await Promise.all([
      fetchUsdRate(normalizedCurrency, true),
      fetchUsdRate(resultCurrency, true),
    ]);
    const rate = publicResultRate(normalizedCurrency, resultCurrency);
    if (!isPositiveRate(rate)) {
      throw new Error(`No public rate was returned for ${normalizedCurrency}.`);
    }

    ensureCurrencyRateDraft(resultCurrency);
    pendingCurrencyRateDraft.rates[normalizedCurrency] = formatRate(rate);
    setNotice(t('currencyRateRefreshed', { currency: normalizedCurrency }));
    render();
  } catch (error) {
    reportError(error);
  }
}

async function seedInitialCurrencyRates() {
  if (
    seedingCurrencyRates
    || initialCurrencyRatesSeeded
    || !profile?.uid
    || !isActiveUser(profile)
    || profile.currencyRates !== undefined
  ) {
    return;
  }

  seedingCurrencyRates = true;
  try {
    const resultCurrency = profileCurrency();
    await Promise.all(
      settings.allowedCurrencies.map((currency) => fetchUsdRate(currency)),
    );

    const currencyRates = {};
    settings.allowedCurrencies.forEach((currency) => {
      if (currency === resultCurrency) return;
      const rate = publicResultRate(currency, resultCurrency);
      if (isPositiveRate(rate)) {
        currencyRates[currency] = rate;
      }
    });

    if (!Object.keys(currencyRates).length) return;

    await updateDoc(doc(db, 'users', profile.uid), {
      currencyRates,
      updatedAt: serverTimestamp(),
    });
    initialCurrencyRatesSeeded = true;
  } catch (error) {
    console.warn('Could not seed initial currency rates.', error);
  } finally {
    seedingCurrencyRates = false;
  }
}

function formatSettlementAmount(amount, currency) {
  if (Math.abs(amount) <= SETTLEMENT_EPSILON) return formatMoney(0, currency);
  const formattedAmount = formatMoney(Math.abs(amount), currency);
  return amount > 0 ? `+${formattedAmount}` : `-${formattedAmount}`;
}

function resultCopy(amount, currency = profileCurrency()) {
  if (amount > SETTLEMENT_EPSILON) return t('resultOwed', { amount: formatMoney(amount, currency) });
  if (amount < -SETTLEMENT_EPSILON) return t('resultOwe', { amount: formatMoney(Math.abs(amount), currency) });
  return t('resultSettled');
}

function accountOptions(selectedUserId, excludedUserId = '') {
  const users = [...selectableUsers];
  const selectedUser = knownUserById(selectedUserId);
  if (selectedUser && !users.some((user) => user.id === selectedUserId)) {
    users.push(selectedUser);
  }

  return users
    .filter((user) => user.id !== excludedUserId)
    .map((user) => (
      `<option value="${escapeHtml(user.id)}"${user.id === selectedUserId ? ' selected' : ''}>${escapeHtml(userAlias(user))}</option>`
    ))
    .join('');
}

function ledgerSplitDocumentId(entryId, debtorId) {
  return `${entryId}_${debtorId}`;
}

function ledgerSplitsForEntry(entryId) {
  return ledgerSplits
    .filter((split) => split.ledgerId === entryId)
    .sort((left, right) => {
      const leftPosition = Number.isInteger(left.position)
        ? left.position
        : Number.MAX_SAFE_INTEGER;
      const rightPosition = Number.isInteger(right.position)
        ? right.position
        : Number.MAX_SAFE_INTEGER;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      const createdDifference = createdAtValue(left) - createdAtValue(right);
      return createdDifference || left.id.localeCompare(right.id);
    });
}

function ledgerEntryClearState(entryId) {
  const splits = ledgerSplitsForEntry(entryId);
  if (!splits.length) return 'empty';
  const clearedCount = splits.filter((split) => split.cleared).length;
  if (clearedCount === 0) return 'active';
  if (clearedCount === splits.length) return 'cleared';
  return 'partial';
}

function ledgerDataReady() {
  return ledgerEntriesReady && ledgerSplitsReady;
}

function updateLedgerSplitInheritedValues(form, creditorId, currency) {
  if (!form) return;

  const creditor = userAlias(knownUserById(creditorId));
  const normalizedCurrency = normalizeCurrency(currency) || DEFAULT_CURRENCY;
  form.querySelectorAll('[data-ledger-split-creditor]').forEach((output) => {
    output.textContent = creditor;
  });
  form.querySelectorAll('[data-ledger-split-currency]').forEach((output) => {
    output.textContent = normalizedCurrency;
  });
  form.querySelectorAll('[data-ledger-split-draft-id]').forEach((row) => {
    const debtorId = row.querySelector('[name="debtorId"]')?.value || '';
    const debtor = userAlias(knownUserById(debtorId));
    [
      row.querySelector('[data-toggle-edit-split]'),
      row.querySelector('[data-delete-edit-split]'),
      row.querySelector('[data-remove-new-split]'),
    ].filter(Boolean).forEach((button) => {
      button.setAttribute(
        'aria-label',
        `${button.textContent.trim()}: ${debtor}`,
      );
    });
  });
}

function nextSplitDraftId() {
  nextLedgerSplitDraftId += 1;
  return `split-draft-${nextLedgerSplitDraftId}`;
}

function createLedgerNewDraft() {
  const creditorId = selectableUsers.some((user) => user.id === profile.uid)
    ? profile.uid
    : selectableUsers[0]?.id || '';
  const debtor = selectableUsers.find((user) => user.id !== creditorId);
  return {
    creditorId,
    currency: normalizeCurrency(settings.defaultCurrency) || DEFAULT_CURRENCY,
    note: '',
    splits: debtor ? [
      {
        amount: '',
        cleared: false,
        debtorId: debtor.id,
        draftId: nextSplitDraftId(),
        id: '',
      },
    ] : [],
  };
}

function discardLedgerNewDraft() {
  ledgerNewDraft = null;
}

function captureLedgerNewDraft(form) {
  if (!form || !ledgerNewDraft) return;
  ledgerNewDraft.creditorId = String(
    form.elements.creditorId?.value || ledgerNewDraft.creditorId,
  );
  ledgerNewDraft.currency = normalizeCurrency(form.elements.currency?.value)
    || ledgerNewDraft.currency;
  ledgerNewDraft.note = String(form.elements.note?.value || '');
  form.querySelectorAll('[data-ledger-split-draft-id]').forEach((row) => {
    const split = ledgerNewDraft.splits.find(
      (item) => item.draftId === row.dataset.ledgerSplitDraftId,
    );
    if (!split) return;
    split.debtorId = row.querySelector('[name="debtorId"]')?.value || '';
    split.amount = row.querySelector('[name="amount"]')?.value || '';
  });
}

function createLedgerEditDraft(entry) {
  const splits = ledgerSplitsForEntry(entry.id);
  return {
    creditorId: entry.creditorId,
    currency: normalizeCurrency(entry.currency) || DEFAULT_CURRENCY,
    entryId: entry.id,
    note: entry.note || '',
    originalSplitIds: splits.map((split) => split.id),
    splits: splits.map((split) => ({
      amount: String(split.amount ?? ''),
      cleared: Boolean(split.cleared),
      debtorId: split.debtorId,
      draftId: nextSplitDraftId(),
      id: split.id,
    })),
  };
}

function discardLedgerEditDraft() {
  editingLedgerEntryId = '';
  ledgerEditDraft = null;
}

function captureLedgerEditDraft(form) {
  if (!form || !ledgerEditDraft) return;
  ledgerEditDraft.note = String(form.elements.note?.value || '');
  ledgerEditDraft.currency = normalizeCurrency(form.elements.currency?.value)
    || ledgerEditDraft.currency;
  form.querySelectorAll('[data-ledger-split-draft-id]').forEach((row) => {
    const split = ledgerEditDraft.splits.find(
      (item) => item.draftId === row.dataset.ledgerSplitDraftId,
    );
    if (!split) return;
    split.debtorId = row.querySelector('[name="debtorId"]')?.value || '';
    split.amount = row.querySelector('[name="amount"]')?.value || '';
  });
}

function availableLedgerDebtor(draft, usedDebtorIds = new Set()) {
  if (!selectableUsers.some((user) => user.id === draft?.creditorId)) {
    return null;
  }
  return selectableUsers.find((user) => (
    user.id !== draft.creditorId
    && !usedDebtorIds.has(user.id)
  )) || null;
}

function reconcileLedgerNewDraftDebtors() {
  if (!ledgerNewDraft) return;

  const usedDebtorIds = new Set();
  ledgerNewDraft.splits.forEach((split) => {
    const debtorIsAvailable = selectableUsers.some((user) => (
      user.id === split.debtorId
      && user.id !== ledgerNewDraft.creditorId
    )) && !usedDebtorIds.has(split.debtorId);
    if (!debtorIsAvailable) {
      split.debtorId = availableLedgerDebtor(
        ledgerNewDraft,
        usedDebtorIds,
      )?.id || '';
    }
    if (split.debtorId) usedDebtorIds.add(split.debtorId);
  });
}

function updateNewEntryCreditor(event) {
  const form = event.currentTarget.form;
  captureLedgerNewDraft(form);
  reconcileLedgerNewDraftDebtors();
  notice = '';
  render();
}

function addNewLedgerSplitDraft(form) {
  if (!ledgerNewDraft) return;
  captureLedgerNewDraft(form);
  if (!selectableUsers.some((user) => user.id === ledgerNewDraft.creditorId)) {
    setErrorNotice(t('inactivePayerCannotAddDebt'));
    return;
  }
  if (ledgerNewDraft.splits.length >= MAX_LEDGER_SPLITS) {
    setErrorNotice(t('maximumDebts', { max: MAX_LEDGER_SPLITS }));
    return;
  }

  const usedDebtorIds = new Set(
    ledgerNewDraft.splits.map((split) => split.debtorId),
  );
  const debtor = availableLedgerDebtor(ledgerNewDraft, usedDebtorIds);
  if (!debtor) {
    setErrorNotice(t('noAvailableDebtors'));
    return;
  }

  ledgerNewDraft.splits.push({
    amount: '',
    cleared: false,
    debtorId: debtor.id,
    draftId: nextSplitDraftId(),
    id: '',
  });
  notice = '';
  render();
}

function removeNewLedgerSplitDraft(form, draftId) {
  captureLedgerNewDraft(form);
  if (!ledgerNewDraft || ledgerNewDraft.splits.length <= 1) return;
  ledgerNewDraft.splits = ledgerNewDraft.splits.filter(
    (split) => split.draftId !== draftId,
  );
  notice = '';
  render();
}

function addLedgerSplitDraft(form) {
  if (!ledgerEditDraft) return;
  captureLedgerEditDraft(form);
  if (!selectableUsers.some((user) => user.id === ledgerEditDraft.creditorId)) {
    setErrorNotice(t('inactivePayerCannotAddDebt'));
    return;
  }
  if (ledgerEditDraft.splits.length >= MAX_LEDGER_SPLITS) {
    setErrorNotice(t('maximumDebts', { max: MAX_LEDGER_SPLITS }));
    return;
  }

  const usedDebtorIds = new Set(
    ledgerEditDraft.splits.map((split) => split.debtorId),
  );
  const debtor = availableLedgerDebtor(ledgerEditDraft, usedDebtorIds);
  if (!debtor) {
    setErrorNotice(t('noAvailableDebtors'));
    return;
  }

  ledgerEditDraft.splits.push({
    amount: '',
    cleared: false,
    debtorId: debtor.id,
    draftId: nextSplitDraftId(),
    id: '',
  });
  notice = '';
  render();
}

function toggleLedgerSplitDraft(form, draftId) {
  captureLedgerEditDraft(form);
  const split = ledgerEditDraft?.splits.find((item) => item.draftId === draftId);
  if (!split) return;
  split.cleared = !split.cleared;
  render();
}

function removeLedgerSplitDraft(form, draftId) {
  captureLedgerEditDraft(form);
  if (!ledgerEditDraft) return;
  if (ledgerEditDraft.splits.length === 1) {
    if (window.confirm(t('deleteLastDebtConfirm'))) {
      void removeLedgerEntry(ledgerEditDraft.entryId);
    }
    return;
  }

  ledgerEditDraft.splits = ledgerEditDraft.splits.filter(
    (split) => split.draftId !== draftId,
  );
  render();
}

function canManageEntry(entry) {
  return entry.createdBy === profile.uid || currentUserIsAdmin();
}

function isValidLedgerImageDataUrl(dataUrl) {
  return typeof dataUrl === 'string' && dataUrl.startsWith('data:image/');
}

function ledgerImagesForEntry(entryId) {
  const images = ledgerImages.get(entryId);
  if (!Array.isArray(images)) return [];
  const seenImageIds = new Set();
  return images.filter((image) => {
    if (!isValidLedgerImageDataUrl(image?.dataUrl) || seenImageIds.has(image.id)) {
      return false;
    }
    seenImageIds.add(image.id);
    return true;
  });
}

function ledgerEntryById(entryId) {
  return ledgerEntries.find((item) => item.id === entryId) || null;
}

function canManageEntryById(entryId) {
  const entry = ledgerEntryById(entryId);
  return entry ? canManageEntry(entry) : false;
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('The selected image could not be loaded.'));
    };
    image.src = objectUrl;
  });
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error('The image could not be compressed.'));
    }, 'image/jpeg', quality);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The image could not be encoded.'));
    reader.readAsDataURL(blob);
  });
}

async function compressLedgerImage(file) {
  const image = await loadImageFile(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const largestSide = Math.max(sourceWidth, sourceHeight);
  if (!largestSide) throw new Error('The selected image has no size.');

  const initialScale = Math.min(1, IMAGE_MAX_DIMENSION / largestSide);
  let width = Math.max(1, Math.round(sourceWidth * initialScale));
  let height = Math.max(1, Math.round(sourceHeight * initialScale));

  while (true) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);

    for (const quality of JPEG_QUALITIES) {
      const blob = await canvasToJpegBlob(canvas, quality);
      if (blob.size <= IMAGE_MAX_BYTES) return blobToDataUrl(blob);
    }

    if (Math.max(width, height) <= IMAGE_MIN_DIMENSION) break;
    width = Math.max(1, Math.round(width * .75));
    height = Math.max(1, Math.round(height * .75));
  }

  throw new Error('The selected image is too large.');
}

async function compressLedgerImageFiles(files) {
  const dataUrls = [];
  for (const file of files) {
    dataUrls.push(await compressLedgerImage(file));
  }
  return dataUrls;
}

function reportLedgerImageError(error) {
  console.warn('Could not add the ledger image.', error);
  setErrorNotice(error.message === 'The selected image is too large.'
    ? t('imageTooLarge')
    : t('operationFailed'));
}

function ledgerEntryImageKey(entryId = '') {
  return entryId
    ? `edit:${entryId}`
    : NEW_LEDGER_ENTRY_IMAGE_KEY;
}

function pendingLedgerEntryImageItems(imageKey) {
  return pendingLedgerEntryImages.get(imageKey) || [];
}

function pendingLedgerEntryImageFiles(imageKey) {
  return pendingLedgerEntryImageItems(imageKey).map((item) => item.file);
}

function revokePendingLedgerEntryImages(imageKey) {
  pendingLedgerEntryImageItems(imageKey).forEach((item) => {
    URL.revokeObjectURL(item.previewUrl);
  });
  pendingLedgerEntryImages.delete(imageKey);
}

function clearAllPendingLedgerEntryImages() {
  [...pendingLedgerEntryImages.keys()].forEach(revokePendingLedgerEntryImages);
}

function addPendingLedgerEntryImages(imageKey, files) {
  const validFiles = Array.from(files || []).filter((file) => file.size > 0);
  if (!validFiles.length) return false;
  if (validFiles.some((file) => !file.type.startsWith('image/'))) {
    setErrorNotice(t('imageUnsupported'));
    return false;
  }

  const queued = [
    ...pendingLedgerEntryImageItems(imageKey),
    ...validFiles.map((file) => ({
      file,
      previewUrl: URL.createObjectURL(file),
    })),
  ];
  pendingLedgerEntryImages.set(imageKey, queued);
  return true;
}

function removePendingLedgerEntryImage(imageKey, pendingIndex) {
  const items = pendingLedgerEntryImageItems(imageKey);
  const item = items[pendingIndex];
  if (!item) return false;
  URL.revokeObjectURL(item.previewUrl);
  items.splice(pendingIndex, 1);
  if (items.length) {
    pendingLedgerEntryImages.set(imageKey, items);
  } else {
    revokePendingLedgerEntryImages(imageKey);
  }
  return true;
}

function ledgerImageViewerEntryId(entryId = '') {
  return entryId || NEW_LEDGER_ENTRY_IMAGE_KEY;
}

function ledgerImageViewerPendingKey(viewerEntryId) {
  return viewerEntryId === NEW_LEDGER_ENTRY_IMAGE_KEY
    ? NEW_LEDGER_ENTRY_IMAGE_KEY
    : `edit:${viewerEntryId}`;
}

function shouldUsePendingLedgerImages(viewerEntryId) {
  if (viewerEntryId === NEW_LEDGER_ENTRY_IMAGE_KEY) return true;
  if (editingLedgerEntryId === viewerEntryId) return true;
  return pendingLedgerEntryImageItems(
    ledgerImageViewerPendingKey(viewerEntryId),
  ).length > 0;
}

function ledgerViewerImages(viewerEntryId) {
  const savedImages = viewerEntryId === NEW_LEDGER_ENTRY_IMAGE_KEY
    ? []
    : ledgerImagesForEntry(viewerEntryId);
  const pendingItems = pendingLedgerEntryImageItems(
    ledgerImageViewerPendingKey(viewerEntryId),
  );
  return [
    ...savedImages.map((image) => ({
      id: image.id,
      dataUrl: image.dataUrl,
      pending: false,
    })),
    ...pendingItems.map((item, index) => ({
      id: `pending:${index}`,
      dataUrl: item.previewUrl,
      pending: true,
    })),
  ];
}

function ledgerImageBackLabel(viewerEntryId) {
  if (viewerEntryId === NEW_LEDGER_ENTRY_IMAGE_KEY) return t('backToNewEntry');
  if (editingLedgerEntryId === viewerEntryId) return t('backToEditEntry');
  return t('backToLedger');
}

function closeLedgerImageViewer() {
  selectedLedgerImageEntryId = '';
  selectedLedgerImageIndex = 0;
}

function renderLedgerEntryImagePicker(entryId = '') {
  const viewerEntryId = ledgerImageViewerEntryId(entryId);
  const imageKey = ledgerEntryImageKey(entryId);
  const savedCount = entryId ? ledgerImagesForEntry(entryId).length : 0;
  const pendingCount = pendingLedgerEntryImageItems(imageKey).length;
  const imageCount = savedCount + pendingCount;
  const label = imageCount
    ? t('viewImageCount', { count: imageCount })
    : t('addImage');

  return `<div class="entry-camera-field">
    <span class="entry-camera-caption">${escapeHtml(t('image'))}</span>
    <button
      class="ledger-image-button secondary-button entry-image-open-button"
      type="button"
      data-view-ledger-image="${escapeHtml(viewerEntryId)}"
      aria-label="${escapeHtml(label)}"
      title="${escapeHtml(label)}"
    >
      <span aria-hidden="true">📷</span>
      <span class="entry-image-count"${imageCount ? '' : ' hidden'} aria-hidden="true">${escapeHtml(imageCount)}</span>
    </button>
  </div>`;
}

function renderLedgerImageButton(entry) {
  const images = ledgerImagesForEntry(entry.id);
  const canManage = canManageEntry(entry);
  if (!images.length && !canManage) return '—';

  const label = images.length
    ? t('viewImageCount', { count: images.length })
    : t('addImage');

  return `<button class="ledger-image-button secondary-button" type="button" data-view-ledger-image="${escapeHtml(entry.id)}" aria-label="${escapeHtml(label)}">📷</button>`;
}

function renderLedgerImageViewer() {
  const viewerEntryId = selectedLedgerImageEntryId;
  const isNewEntryDraft = viewerEntryId === NEW_LEDGER_ENTRY_IMAGE_KEY;
  const entry = isNewEntryDraft ? null : ledgerEntryById(viewerEntryId);

  if (!isNewEntryDraft && !entry) {
    closeLedgerImageViewer();
    return renderLedger();
  }

  const viewerImages = ledgerViewerImages(viewerEntryId);
  const canManage = isNewEntryDraft
    ? true
    : entry && canManageEntry(entry);
  const maxIndex = Math.max(0, viewerImages.length - 1);
  const currentIndex = viewerImages.length
    ? Math.min(Math.max(selectedLedgerImageIndex, 0), maxIndex)
    : 0;
  selectedLedgerImageIndex = currentIndex;
  const currentImage = viewerImages[currentIndex] || null;

  let imageContext;
  if (isNewEntryDraft) {
    const note = ledgerNewDraft?.note?.trim();
    imageContext = note || t('newEntry');
  } else {
    const creditor = userAlias(knownUserById(entry.creditorId));
    imageContext = entry.note
      ? `${entry.note} · ${t('paidBy')} ${creditor}`
      : `${t('paidBy')} ${creditor}`;
  }

  return `<section class="page-content narrow-content ledger-image-page">
    <div class="page-heading ledger-image-heading">
      <div>
        <h2>${escapeHtml(t('image'))}</h2>
        <p class="muted">${escapeHtml(imageContext)}</p>
      </div>
    </div>
    <section class="accounting-card ledger-image-view">
      ${currentImage
    ? `<div class="ledger-image-stage"><img src="${escapeHtml(currentImage.dataUrl)}" alt="${escapeHtml(t('ledgerImage'))}" /></div>`
    : `<p class="muted ledger-image-empty">${escapeHtml(t('noImagesYet'))}</p>`}
      ${viewerImages.length > 0 ? `<div class="ledger-image-nav">
        <button class="secondary-button" type="button" data-action="ledger-image-prev"${currentIndex === 0 ? ' disabled' : ''}>${escapeHtml(t('previousImage'))}</button>
        <span class="ledger-image-count">${escapeHtml(t('imagePosition', { current: currentIndex + 1, total: Math.max(viewerImages.length, 1) }))}</span>
        <button class="secondary-button" type="button" data-action="ledger-image-next"${currentIndex >= maxIndex ? ' disabled' : ''}>${escapeHtml(t('nextImage'))}</button>
      </div>` : ''}
      ${canManage ? `<div class="ledger-image-actions">
        <label class="file-picker ledger-image-action">
          <input class="sr-only" id="ledger-image-upload" name="imageUpload" type="file" accept="image/*" multiple />
          <span>${escapeHtml(t('uploadImage'))}</span>
        </label>
        <label class="file-picker ledger-image-action">
          <input class="sr-only" id="ledger-image-camera" name="imageCamera" type="file" accept="image/*" capture="environment" />
          <span>${escapeHtml(t('takePhoto'))}</span>
        </label>
        <button
          class="secondary-button ledger-image-action danger-text"
          type="button"
          data-delete-ledger-image="${currentImage ? escapeHtml(currentImage.id) : ''}"
          ${currentImage ? '' : 'disabled'}
        >${escapeHtml(t('deleteImage'))}</button>
      </div>` : ''}
    </section>
    <div class="ledger-image-footer">
      <button class="secondary-button" type="button" data-action="back-from-ledger-image">${escapeHtml(ledgerImageBackLabel(viewerEntryId))}</button>
    </div>
  </section>`;
}

function navigationItem(view, icon, label) {
  return `<button class="nav-item${activeView === view ? ' chosen' : ''}" type="button" data-view="${view}">
    <span class="nav-icon" aria-hidden="true">${icon}</span>
    <span class="nav-label">${escapeHtml(label)}</span>
  </button>`;
}

function renderCurrencyConversionSettings() {
  const resultCurrency = selectedResultCurrency();
  const personalRates = personalResultRates(resultCurrency);
  const rateDraft = pendingCurrencyRateDraft?.resultCurrency === resultCurrency
    ? pendingCurrencyRateDraft.rates
    : null;
  const rateRows = settings.allowedCurrencies
    .filter((currency) => currency !== resultCurrency)
    .map((currency) => {
      requestPublicResultRate(currency, resultCurrency);
      const publicRate = publicResultRate(currency, resultCurrency);
      const rateUnavailable = publicResultRateUnavailable(currency, resultCurrency);
      const hasDraftRate = rateDraft
        && Object.prototype.hasOwnProperty.call(rateDraft, currency);
      const savedRate = hasDraftRate
        ? rateDraft[currency]
        : personalRates[currency] || '';
      const placeholder = publicRate
        ? formatRate(publicRate)
        : rateUnavailable ? t('publicRateUnavailable') : t('publicRateLoading');
      return `<tr>
      <td><strong>${escapeHtml(currency)}</strong></td>
      <td>
        <label class="currency-rate-control">
          <span>1 ${escapeHtml(currency)} =</span>
          <input name="currencyRate-${escapeHtml(currency)}" type="text" inputmode="decimal" autocomplete="off" data-currency-rate-input value="${escapeHtml(String(savedRate))}" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(t('currencyRateInputLabel', {
            currency,
            resultCurrency,
          }))}" />
          <span>${escapeHtml(resultCurrency)}</span>
          <button class="icon-button currency-rate-refresh" type="button" data-refresh-currency-rate="${escapeHtml(currency)}" aria-label="${escapeHtml(t('refreshCurrencyRate', { currency }))}" title="${escapeHtml(t('refreshCurrencyRate', { currency }))}">↻</button>
        </label>
      </td>
    </tr>`;
    }).join('');

  return `<section class="accounting-card currency-conversion-card">
    <div class="card-heading"><div><h3>${escapeHtml(t('conversionSettings'))}</h3><p>${escapeHtml(t('conversionSettingsHelp'))}</p></div></div>
    <form id="currency-conversion-form" class="stack-form">
      <label class="field conversion-currency-field"><span>${escapeHtml(t('resultCurrency'))}</span><select id="currency-result-currency" name="resultCurrency">${renderCurrencyOptions(resultCurrency)}</select></label>
      <p class="muted">${escapeHtml(t('currencyRateHelp'))}</p>
      <div class="table-wrap currency-rate-table-wrap">
        <table class="currency-rate-table">
          <thead><tr><th>${escapeHtml(t('currency'))}</th><th>${escapeHtml(t('resultCurrency'))}</th></tr></thead>
          <tbody>${rateRows}</tbody>
        </table>
      </div>
      <button type="submit">${escapeHtml(t('save'))}</button>
    </form>
  </section>`;
}

function renderSettlementSummary(myBalance) {
  const currency = profileCurrency();
  const balances = calculateBalances();
  const settlements = calculatedSettlements;
  const unavailableCurrencies = unavailableLedgerRateCurrencies(currency);
  const exchangeRateWarning = unavailableCurrencies.length
    ? t('exchangeRatesUnavailableWarning', {
      currencies: unavailableCurrencies.join(', '),
    })
    : '';
  const balanceUsers = knownUsers.filter((user) => (
    isSelectableLedgerUser(user) || balances.has(user.id)
  ));
  const balanceRows = balanceUsers.map((user) => {
    const amount = balances.get(user.id) || 0;
    const balanceClass = amount > SETTLEMENT_EPSILON
      ? 'credit'
      : amount < -SETTLEMENT_EPSILON
        ? 'debt'
        : '';
    return `<div class="settlement-row">
      <span class="settlement-name" title="${escapeHtml(userAlias(user))}">${escapeHtml(userAlias(user))}</span>
      <strong class="${balanceClass}">${escapeHtml(formatSettlementAmount(amount, currency))}</strong>
    </div>`;
  }).join('');
  const settlementRows = (settlements || []).map((settlement) => {
    const debtor = userAlias(knownUserById(settlement.debtorId));
    const creditor = userAlias(knownUserById(settlement.creditorId));
    return `<div class="settlement-row">
      <span class="settlement-transfer" aria-label="${escapeHtml(t('settlementTransfer', { debtor, creditor }))}">
        <span class="settlement-name" title="${escapeHtml(debtor)}">${escapeHtml(debtor)}</span>
        <span class="settlement-arrow" aria-hidden="true">${escapeHtml(t('transferConnector'))}</span>
        <span class="settlement-name" title="${escapeHtml(creditor)}">${escapeHtml(creditor)}</span>
      </span>
      <strong class="credit">${escapeHtml(formatMoney(settlement.amount, currency))}</strong>
    </div>`;
  }).join('');
  const settlementTransferContent = settlements === null
    ? `<p class="muted">${escapeHtml(t('settlementCalculationHelp'))}</p><button type="button" data-action="calculate-settlements">${escapeHtml(t('calculateSettlements'))}</button>`
    : settlementRows || `<p class="muted">${escapeHtml(t('settlementNoTransfers'))}</p>`;

  const helpText = t('settlementSummaryHelp', { currency: `<strong class="highlight-currency">${escapeHtml(currency)}</strong>` });
  
  return `<section class="accounting-card settlement-card">
    <div class="card-heading">
      <div>
        <h3>${escapeHtml(t('settlementSummary'))}</h3>
        <p>${helpText}</p>
      </div>
    </div>
    ${exchangeRateWarning ? `<p class="notice notice-error" role="alert">${escapeHtml(exchangeRateWarning)}</p>` : ''}
    <section class="result-card settlement-result-card" aria-label="${escapeHtml(t('myResult'))}">
      <p>${escapeHtml(t('myResult'))}</p>
      <strong class="${myBalance > SETTLEMENT_EPSILON ? 'credit' : myBalance < -SETTLEMENT_EPSILON ? 'debt' : ''}">${escapeHtml(resultCopy(myBalance, currency))}</strong>
    </section>
    <div class="settlement-summary-grid">
      <section>
        <h4>${escapeHtml(t('settlementBalances'))}</h4>
        <div class="settlement-list">${balanceRows}</div>
      </section>
      <section>
        <h4>${escapeHtml(t('settlementTransfers'))}</h4>
        <div class="settlement-list">${settlementTransferContent}</div>
      </section>
    </div>
  </section>`;
}

function renderLedgerEntryEdit(entry) {
  if (!ledgerEditDraft || ledgerEditDraft.entryId !== entry.id) {
    ledgerEditDraft = createLedgerEditDraft(entry);
  }

  const creditor = userAlias(knownUserById(ledgerEditDraft.creditorId));
  const usedDebtorIds = new Set(
    ledgerEditDraft.splits.map((split) => split.debtorId),
  );
  const canAddDebt = ledgerEditDraft.splits.length < MAX_LEDGER_SPLITS
    && Boolean(availableLedgerDebtor(ledgerEditDraft, usedDebtorIds));
  const splitRows = ledgerEditDraft.splits.map((split) => {
    const debtor = userAlias(knownUserById(split.debtorId));
    const toggleLabel = t(split.cleared ? 'restoreEntry' : 'clearEntry');
    return `
      <div
        class="entry-split-row ledger-split-edit-row${split.cleared ? ' ledger-split-cleared' : ''}"
        data-ledger-split-draft-id="${escapeHtml(split.draftId)}"
      >
        <div class="entry-split-party">
          <label class="field">
            <span class="entry-split-label">${escapeHtml(t('debtor'))}</span>
            <select
              name="debtorId"
              aria-label="${escapeHtml(t('debtor'))}"
              ${split.id ? 'disabled' : ''}
            >
              ${accountOptions(split.debtorId, ledgerEditDraft.creditorId)}
            </select>
          </label>
          <span class="ledger-split-field-context">
            <span>${escapeHtml(t('debtConnector'))}</span>
            <output
              data-ledger-split-creditor
              aria-label="${escapeHtml(t('creditor'))}"
            >${escapeHtml(creditor)}</output>
          </span>
        </div>
        <div class="entry-split-money">
          <label class="field entry-amount-field">
            <span class="entry-split-label">${escapeHtml(t('amount'))}</span>
            <input
              name="amount"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              value="${escapeHtml(split.amount)}"
              required
            />
          </label>
          <output
            class="ledger-split-field-context"
            data-ledger-split-currency
            aria-label="${escapeHtml(t('currency'))}"
          >${escapeHtml(ledgerEditDraft.currency)}</output>
        </div>
        <div class="entry-split-actions ledger-split-edit-actions">
          <button
            class="secondary-button"
            type="button"
            data-toggle-edit-split="${escapeHtml(split.draftId)}"
            aria-label="${escapeHtml(`${toggleLabel}: ${debtor}`)}"
          >${escapeHtml(toggleLabel)}</button>
          <button
            class="secondary-button danger-text"
            type="button"
            data-delete-edit-split="${escapeHtml(split.draftId)}"
            aria-label="${escapeHtml(`${t('removeDebt')}: ${debtor}`)}"
          >${escapeHtml(t('removeDebt'))}</button>
        </div>
      </div>
    `;
  }).join('');

  return `<article class="ledger-group ledger-group-editing">
    <form id="ledger-edit-form" class="entry-form ledger-edit-form">
      <div class="entry-note-row">
        <label class="field"><span>${escapeHtml(t('note'))}</span><input name="note" maxlength="${MAX_LEDGER_NOTE_LENGTH}" value="${escapeHtml(ledgerEditDraft.note)}" placeholder="${escapeHtml(t('notePlaceholder'))}" /></label>
        ${renderLedgerEntryImagePicker(entry.id)}
      </div>
      <div class="entry-shared-fields ledger-edit-shared-fields">
        <label class="field">
          <span>${escapeHtml(t('creditor'))}</span>
          <input value="${escapeHtml(creditor)}" readonly />
        </label>
        <label class="field">
          <span>${escapeHtml(t('currency'))}</span>
          <select name="currency">${renderCurrencyOptions(ledgerEditDraft.currency)}</select>
        </label>
      </div>
      <section class="entry-debts ledger-edit-debts">
        <div class="card-heading">
          <div>
            <h4>${escapeHtml(t('debts'))}</h4>
          </div>
          <button
            class="secondary-button"
            type="button"
            data-add-edit-split
            ${canAddDebt ? '' : 'disabled'}
          >${escapeHtml(t('addDebt'))}</button>
        </div>
        <div class="entry-split-list ledger-split-edit-list">
          ${splitRows || `<p class="muted">${escapeHtml(t('noDebts'))}</p>`}
        </div>
      </section>
      <div class="ledger-edit-actions">
        <button type="submit">${escapeHtml(t('saveChanges'))}</button>
        <button class="secondary-button" type="button" data-cancel-edit-entry="${escapeHtml(entry.id)}">${escapeHtml(t('cancel'))}</button>
      </div>
    </form>
  </article>`;
}

function filteredLedgerEntries() {
  const filter = ledgerFilter.trim().toLocaleLowerCase();
  if (!filter) return ledgerEntries;

  return ledgerEntries.filter((entry) => {
    const creditor = userAlias(knownUserById(entry.creditorId));
    const splitSearchValues = ledgerSplitsForEntry(entry.id).flatMap((split) => {
      const amount = Number(split.amount);
      return [
        userAlias(knownUserById(split.debtorId)),
        Number.isFinite(amount) ? String(amount) : '',
        Number.isFinite(amount) ? amount.toFixed(2) : '',
      ];
    });
    const searchText = [
      creditor,
      entry.currency || '',
      entry.note || '',
      ...splitSearchValues,
    ].join(' ').toLocaleLowerCase();

    return searchText.includes(filter);
  });
}

function renderLedgerRows(entries = ledgerEntries) {
  if (!ledgerDataReady()) {
    return `<p class="ledger-empty">${escapeHtml(t('loading'))}</p>`;
  }
  if (!entries.length) {
    const message = ledgerEntries.length ? 'noMatchingEntries' : 'noEntries';
    return `<p class="ledger-empty">${escapeHtml(t(message))}</p>`;
  }

  return entries.map((entry) => {
    if (editingLedgerEntryId === entry.id) {
      return renderLedgerEntryEdit(entry);
    }

    const splits = ledgerSplitsForEntry(entry.id);
    const creditor = userAlias(knownUserById(entry.creditorId));
    const creator = entry.createdBy 
      ? userAlias(knownUserById(entry.createdBy)) || t('unknownUser')
      : '—';
    const clearState = ledgerEntryClearState(entry.id);
    const status = clearState === 'partial'
      ? t('partiallyCleared')
      : clearState === 'cleared'
        ? t('clearedStatus')
        : '';
    const splitRows = splits.map((split) => {
      const debtor = userAlias(knownUserById(split.debtorId));
      const amount = Number(split.amount);
      return `<div class="ledger-split-row${split.cleared ? ' ledger-split-cleared' : ''}">
        ${split.cleared ? `<span class="sr-only">${escapeHtml(t('clearedStatus'))}</span>` : ''}
        <span class="ledger-split-people">
          <strong title="${escapeHtml(debtor)}">${escapeHtml(debtor)}</strong>
          <span>${escapeHtml(t('debtConnector'))}</span>
          <strong title="${escapeHtml(creditor)}">${escapeHtml(creditor)}</strong>
        </span>
        <strong class="ledger-split-amount">${escapeHtml(Number.isFinite(amount) ? amount.toFixed(2) : '0.00')} ${escapeHtml(entry.currency || DEFAULT_CURRENCY)}</strong>
      </div>`;
    }).join('');
    const actions = canManageEntry(entry)
      ? `<div class="ledger-group-actions">
        <button class="clear-entry-button" type="button" data-edit-entry="${escapeHtml(entry.id)}">${escapeHtml(t('editEntry'))}</button>
        ${splits.length ? `<button class="clear-entry-button" type="button" data-toggle-clear-entry="${escapeHtml(entry.id)}">${escapeHtml(t(clearState === 'cleared' ? 'restoreAllDebts' : 'clearAllDebts'))}</button>` : ''}
        <button class="clear-entry-button danger" type="button" data-delete-entry="${escapeHtml(entry.id)}">${escapeHtml(t('deleteEntry'))}</button>
      </div>`
      : '';
    const footerExpanded = ledgerExpandedFooters.has(entry.id);
    const footerToggleIcon = footerExpanded ? '▼' : '▶';
    return `<article class="ledger-group ledger-group-${escapeHtml(clearState)}">
      <header class="ledger-group-header">
        <div class="ledger-group-title">
          <strong class="ledger-group-note">${escapeHtml(entry.note || '—')}</strong>
          ${status ? `<span class="ledger-group-status">${escapeHtml(status)}</span>` : ''}
        </div>
        <div class="ledger-group-header-tools">
          <div class="ledger-image-cell">${renderLedgerImageButton(entry)}</div>
          <button
            class="ledger-row-meta-toggle"
            type="button"
            data-toggle-row-meta="${escapeHtml(entry.id)}"
            aria-expanded="${footerExpanded}"
            aria-controls="ledger-group-footer-${escapeHtml(entry.id)}"
            title="${escapeHtml(footerExpanded ? t('hideEntryDetails') : t('showEntryDetails'))}"
          >${footerToggleIcon}</button>
        </div>
      </header>
      <div class="ledger-split-list">
        ${splitRows || `<p class="muted">${escapeHtml(t('noDebts'))}</p>`}
      </div>
      <footer id="ledger-group-footer-${escapeHtml(entry.id)}" class="ledger-group-footer${footerExpanded ? '' : ' ledger-group-footer-collapsed'}">
        <span class="ledger-group-creator">${escapeHtml(t('createdBy', { name: creator }))}</span>
        ${actions}
      </footer>
    </article>`;
  }).join('');
}

function refreshLedgerRows() {
  const rows = document.querySelector('#ledger-rows');
  if (!rows) return;

  rows.innerHTML = renderLedgerRows(filteredLedgerEntries());
  bindLedgerRows();
}

function renderNewEntry() {
  const canAddEntry = selectableUsers.length > 1;
  if (canAddEntry && !ledgerNewDraft) {
    ledgerNewDraft = createLedgerNewDraft();
  }

  const draft = ledgerNewDraft;
  const entryCurrency = draft?.currency || settings.defaultCurrency;
  const creditor = userAlias(knownUserById(draft?.creditorId));
  const usedDebtorIds = new Set(
    draft?.splits.map((split) => split.debtorId) || [],
  );
  const canAddDebt = Boolean(draft)
    && draft.splits.length < MAX_LEDGER_SPLITS
    && Boolean(availableLedgerDebtor(draft, usedDebtorIds));
  const canRemoveDebt = (draft?.splits.length || 0) > 1;
  const splitRows = draft?.splits.map((split) => {
    const debtor = userAlias(knownUserById(split.debtorId));
    return `
      <div
        class="entry-split-row"
        data-ledger-split-draft-id="${escapeHtml(split.draftId)}"
      >
        <div class="entry-split-party">
          <label class="field new-entry-debtor-field">
            <span class="entry-split-label">${escapeHtml(t('debtor'))}</span>
            <select
              name="debtorId"
              aria-label="${escapeHtml(t('debtor'))}"
            >${accountOptions(split.debtorId, draft.creditorId)}</select>
          </label>
          <span class="ledger-split-field-context">
            <span>${escapeHtml(t('debtConnector'))}</span>
            <output
              data-ledger-split-creditor
              aria-label="${escapeHtml(t('creditor'))}"
            >${escapeHtml(creditor)}</output>
          </span>
        </div>
        <div class="entry-split-money">
          <label class="field entry-amount-field new-entry-amount-field">
            <span class="entry-split-label">${escapeHtml(t('amount'))}</span>
            <input
              name="amount"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              value="${escapeHtml(split.amount)}"
              required
            />
          </label>
          <output
            class="ledger-split-field-context"
            data-ledger-split-currency
            aria-label="${escapeHtml(t('currency'))}"
          >${escapeHtml(entryCurrency)}</output>
        </div>
        ${canRemoveDebt ? `<div class="entry-split-actions">
          <button
            class="secondary-button danger-text"
            type="button"
            data-remove-new-split="${escapeHtml(split.draftId)}"
            aria-label="${escapeHtml(`${t('removeDebt')}: ${debtor}`)}"
          >${escapeHtml(t('removeDebt'))}</button>
        </div>` : ''}
      </div>
    `;
  }).join('') || '';

  return `<section class="page-content narrow-content">
    <div class="page-heading">
      <div>
        <h2>${escapeHtml(t('newEntry'))}</h2>
        <p class="muted">${escapeHtml(t('newEntryCurrency', { currency: entryCurrency }))}</p>
      </div>
    </div>

    <section class="accounting-card">
      ${canAddEntry ? `<form id="ledger-form" class="entry-form new-entry-form">
        <div class="entry-note-row">
          <label class="field"><span>${escapeHtml(t('note'))}</span><input name="note" maxlength="${MAX_LEDGER_NOTE_LENGTH}" value="${escapeHtml(draft.note)}" placeholder="${escapeHtml(t('notePlaceholder'))}" /></label>
          ${renderLedgerEntryImagePicker()}
        </div>
        <div class="entry-details-row new-entry-layout">
          <div class="entry-shared-fields">
            <label class="field new-entry-creditor-field">
              <span>${escapeHtml(t('creditor'))}</span>
              <select name="creditorId" aria-label="${escapeHtml(t('creditor'))}">${accountOptions(draft.creditorId)}</select>
            </label>
            <label class="field new-entry-currency-field">
              <span>${escapeHtml(t('currency'))}</span>
              <select name="currency">${renderCurrencyOptions(entryCurrency)}</select>
            </label>
          </div>
          <section class="entry-debts">
            <div class="card-heading">
              <div>
                <h4>${escapeHtml(t('debts'))}</h4>
              </div>
              <button
                class="secondary-button"
                type="button"
                data-add-new-split
                ${canAddDebt ? '' : 'disabled'}
              >${escapeHtml(t('addDebt'))}</button>
            </div>
            <div class="entry-split-list">
              ${splitRows}
            </div>
          </section>
        </div>
        <button type="submit">${escapeHtml(t('saveEntry'))}</button>
      </form>` : `<p class="muted">${escapeHtml(t('needTwoUsers'))}</p>`}
    </section>
  </section>`;
}

function renderConversion() {
  return `<section class="page-content narrow-content">
    <div class="page-heading">
      <div>
        <h2>${escapeHtml(t('conversionSettings'))}</h2>
        <p class="muted">${escapeHtml(t('conversionSettingsHelp'))}</p>
      </div>
    </div>

    ${renderCurrencyConversionSettings()}
  </section>`;
}

function renderLedger() {
  const dataReady = ledgerDataReady();
  const myBalance = dataReady
    ? calculateBalances().get(profile.uid) || 0
    : 0;
  const hasFilter = ledgerFilter.length > 0;
  const clearFilterButton = `<button class="ledger-filter-clear${hasFilter ? '' : ' hidden'}" type="button" data-action="clear-ledger-filter" aria-label="${escapeHtml(t('clearFilter'))}" title="${escapeHtml(t('clearFilter'))}">&times;</button>`;
  const toggleIcon = ledgerCollapsed ? '▶' : '▼';

  return `<section class="page-content">
    <div class="page-heading">
      <div>
        <h2>${escapeHtml(t('accounting'))}</h2>
        <p class="muted">${escapeHtml(t('ledgerHelp'))}</p>
      </div>
    </div>

    <section class="accounting-card ledger-card">
      <div class="ledger-filter-row">
        <label class="field ledger-filter">
          <span class="sr-only">${escapeHtml(t('ledgerSearch'))}</span>
          <input id="ledger-filter" type="search" value="${escapeHtml(ledgerFilter)}" placeholder="${escapeHtml(t('ledgerSearchPlaceholder'))}" aria-label="${escapeHtml(t('ledgerSearch'))}" autocomplete="off" />
          ${clearFilterButton}
        </label>
        <button class="ledger-collapse-toggle" type="button" data-action="toggle-ledger-collapse" aria-expanded="${!ledgerCollapsed}" aria-controls="ledger-rows" title="${escapeHtml(ledgerCollapsed ? t('showLedger') : t('hideLedger'))}">${toggleIcon}</button>
      </div>
      <div id="ledger-rows" class="ledger-list${ledgerCollapsed ? ' ledger-list-collapsed' : ''}">${renderLedgerRows(filteredLedgerEntries())}</div>
    </section>

    ${dataReady ? renderSettlementSummary(myBalance) : ''}
  </section>`;
}

function renderAccount() {
  const isAdmin = currentUserIsAdmin();
  const adminContent = isAdmin ? `
    ${renderAdminUsers()}
    ${renderAdminBackup()}
    ${renderAdminLedgerData()}
    ${renderAdminCurrencySettings(currentAdminCurrencySettings())}
  ` : '';

  return `<section class="page-content narrow-content">
    <div class="page-heading"><div><h2>${escapeHtml(t('account'))}</h2></div></div>
    <section class="accounting-card">
      <form id="account-form" class="stack-form">
        <label class="field"><span>${escapeHtml(t('alias'))}</span><input name="alias" maxlength="40" value="${escapeHtml(userAlias(profile))}" required /></label>
        <p class="muted">${escapeHtml(t('accountHelp'))}</p>
        <button type="submit">${escapeHtml(t('save'))}</button>
      </form>
    </section>
    <section class="accounting-card account-preferences">
      <div class="card-heading"><div><h3>${escapeHtml(t('displayPreferences'))}</h3></div></div>
      <div class="account-preferences-actions">
        ${preferenceControls()}
      </div>
    </section>
    ${adminContent}
    <section class="accounting-card account-signout-card">
      <button class="secondary-button account-signout-button" type="button" data-action="signout">${escapeHtml(t('signOut'))}</button>
    </section>
  </section>`;
}

function shareUrl() {
  return `${window.location.origin}/`;
}

function renderInstallPanel() {
  if (appInstalled) {
    return `<p class="install-status">${escapeHtml(t('installed'))}</p>`;
  }

  if (deferredInstallPrompt) {
    return `<button type="button" data-action="install-app">${escapeHtml(t('install'))}</button>`;
  }

  return `<p class="muted">${escapeHtml(t('installHelp'))}</p>`;
}

function renderShare() {
  const url = shareUrl();
  return `<section class="page-content narrow-content">
    <div class="page-heading"><div><h2>${escapeHtml(t('shareInstall'))}</h2></div></div>
    <section class="accounting-card share-card">
      <div class="card-heading"><div><h3>${escapeHtml(t('shareHeading'))}</h3><p>${escapeHtml(t('shareHelp'))}</p></div></div>
      <div class="share-url-row">
        <input id="share-url" value="${escapeHtml(url)}" readonly aria-label="${escapeHtml(t('shareUrlLabel'))}" />
        <button type="button" data-action="copy-share-url">${escapeHtml(t('copyUrl'))}</button>
      </div>
      <div class="qr-frame"><img id="share-qr" data-share-url="${escapeHtml(url)}" alt="${escapeHtml(t('qrCode'))}" hidden /></div>
    </section>
    <section class="accounting-card">
      <div class="card-heading"><div><h3>${escapeHtml(t('install'))}</h3><p>${escapeHtml(t('installHelp'))}</p></div></div>
      ${renderInstallPanel()}
    </section>
  </section>`;
}

function statusBadge(user) {
  const status = user.disabled === true && user.status === 'active'
    ? 'disabled'
    : user.status || 'pending';
  const statusKey = {
    active: 'statusActive',
    disabled: 'statusDisabled',
    pending: 'statusPending',
    rejected: 'statusRejected',
    removed: 'statusRemoved',
  }[status] || 'statusPending';
  return `<span class="status-badge status-${escapeHtml(status)}">${escapeHtml(t(statusKey))}</span>`;
}

function renderUserRoleControl(user) {
  const googleVerified = userHasVerifiedGoogleIdentity(user.id);
  const canChangeRole = user.id !== profile.uid && user.status === 'active';
  return `<select
    class="admin-user-role"
    data-user-role="${escapeHtml(user.id)}"
    aria-label="${escapeHtml(`${t('role')}: ${userAlias(user)}`)}"
    ${canChangeRole ? '' : 'disabled'}
  >
    <option value="user"${user.role === 'admin' ? '' : ' selected'}>${escapeHtml(t('roleUser'))}</option>
    <option
      value="admin"
      ${user.role === 'admin' ? 'selected' : ''}
      ${googleVerified ? '' : 'disabled'}
    >${escapeHtml(t('roleAdmin'))}</option>
  </select>`;
}

function renderUserLedgerSelectableControl(user) {
  const canChangeLedgerSelection = user.status === 'active';
  return `<label class="admin-user-ledger-toggle">
    <input
      type="checkbox"
      role="switch"
      data-user-ledger-selectable="${escapeHtml(user.id)}"
      aria-label="${escapeHtml(`${t('ledgerSelectable')}: ${userAlias(user)}`)}"
      ${user.ledgerSelectable === false ? '' : 'checked'}
      ${canChangeLedgerSelection ? '' : 'disabled'}
    />
    <span>${escapeHtml(t('ledgerSelectable'))}</span>
  </label>`;
}

function renderUserActions(user) {
  const actions = [];

  if (user.status === 'pending') {
    actions.push(
      `<button type="button" data-user-status="active" data-user-id="${escapeHtml(user.id)}">${escapeHtml(t('approve'))}</button>`,
      `<button class="secondary-button danger-text" type="button" data-user-status="rejected" data-user-id="${escapeHtml(user.id)}">${escapeHtml(t('reject'))}</button>`,
    );
  } else if (user.status === 'rejected') {
    actions.push(
      `<button type="button" data-user-status="active" data-user-id="${escapeHtml(user.id)}">${escapeHtml(t('approve'))}</button>`,
    );
  } else if (user.status === 'removed') {
    actions.push(
      `<button type="button" data-user-status="active" data-user-id="${escapeHtml(user.id)}">${escapeHtml(t('restoreUser'))}</button>`,
    );
  } else if (user.status === 'active' && user.id !== profile.uid) {
    const nextDisabled = user.disabled === true ? 'false' : 'true';
    actions.push(
      `<button class="secondary-button" type="button" data-user-disabled="${nextDisabled}" data-user-id="${escapeHtml(user.id)}">${escapeHtml(t(user.disabled === true ? 'enableUser' : 'disableUser'))}</button>`,
    );
  }

  if (user.id !== profile.uid && user.status !== 'removed') {
    actions.push(
      `<button class="secondary-button danger-text" type="button" data-remove-user="${escapeHtml(user.id)}">${escapeHtml(t('removeUser'))}</button>`,
    );
  }

  return actions.join('') || '<span class="muted">—</span>';
}

function isAdminUserHiddenByDefault(user) {
  return user.status === 'removed'
    || user.status === 'rejected'
    || (user.status === 'active' && user.disabled === true);
}

function visibleManagedUsers() {
  if (adminShowAllUsers) return managedUsers;
  return managedUsers.filter((user) => !isAdminUserHiddenByDefault(user));
}

function renderUserRows() {
  const users = visibleManagedUsers();
  if (!users.length) {
    return `<tr><td colspan="5" class="muted">${escapeHtml(t('noVisibleUsers'))}</td></tr>`;
  }

  return users.map((user) => {
    const googleVerified = userHasVerifiedGoogleIdentity(user.id);
    return `<tr>
      <td>
        <div style="display: flex; align-items: center; gap: .75rem;">
          ${renderUserAvatar(user)}
          <div style="min-width: 0; overflow: hidden; text-overflow: ellipsis;">
            <strong>${escapeHtml(userAlias(user))}</strong><br />
            <span class="muted">${escapeHtml(user.email || 'N/A')}</span><br />
            <span class="admin-user-provider${googleVerified ? ' google-verified' : ''}">${escapeHtml(t(googleVerified ? 'googleVerified' : 'googleVerificationRequired'))}</span>
          </div>
        </div>
      </td>
      <td>${renderUserRoleControl(user)}</td>
      <td>${renderUserLedgerSelectableControl(user)}</td>
      <td>${statusBadge(user)}</td>
      <td class="user-actions">${renderUserActions(user)}</td>
    </tr>`;
  }).join('');
}

function renderAdminCurrencySettings(adminSettings) {
  return `<section class="accounting-card">
      <div class="card-heading"><div><h3>${escapeHtml(t('allowedCurrencies'))}</h3><p>${escapeHtml(t('settingsRegistrationHelp'))}</p></div></div>
      <form id="app-settings-form" class="stack-form">
        <label class="field"><span>${escapeHtml(t('defaultCurrency'))}</span><select id="app-settings-default-currency" name="defaultCurrency">${renderCurrencyOptions(adminSettings.defaultCurrency, adminSettings.allowedCurrencies)}</select></label>
        <div class="allowed-currency-controls">
          <label class="field"><span>${escapeHtml(t('currencyCode'))}</span><input id="allowed-currency-code" maxlength="3" placeholder="${escapeHtml(t('currencyCodePlaceholder'))}" autocomplete="off" autocapitalize="characters" list="currency-suggestions" /></label>
          <button class="secondary-button" type="button" data-action="add-allowed-currency">${escapeHtml(t('addCurrency'))}</button>
        </div>
        <datalist id="currency-suggestions">${renderCurrencySuggestions()}</datalist>
        <div class="allowed-currency-list" aria-label="${escapeHtml(t('allowedCurrencies'))}" aria-live="polite">${renderAllowedCurrencyChips(adminSettings.allowedCurrencies, adminSettings.defaultCurrency)}</div>
        <p class="muted">${escapeHtml(t('allowedCurrenciesHelp'))}</p>
        <button type="submit">${escapeHtml(t('save'))}</button>
      </form>
    </section>`;
}

function removedUsers() {
  return managedUsers.filter((user) => user.status === 'removed');
}

function isUserReferencedInLedger(userId) {
  return ledgerEntries.some((entry) => (
    entry.creditorId === userId || entry.createdBy === userId
  )) || ledgerSplits.some((split) => split.debtorId === userId);
}

function renderAdminUsers() {
  const removedUserCount = removedUsers().length;
  const clearRemovedUsersButton = removedUserCount ? `<button
          class="secondary-button danger-text admin-clear-removed-users"
          type="button"
          data-action="clear-removed-users"
          title="${escapeHtml(t('clearRemovedUsersHelp'))}"
          aria-label="${escapeHtml(t('clearRemovedUsers', { count: removedUserCount }))}"
          ${isClearingRemovedUsers || isClearingLedgerData || isBackupBusy ? 'disabled' : ''}
        >${escapeHtml(t(isClearingRemovedUsers ? 'clearingRemovedUsers' : 'clearRemovedUsers', { count: removedUserCount }))}</button>` : '';

  return `<section class="accounting-card admin-users-card">
      <div class="card-heading admin-users-heading">
        <div><h3>${escapeHtml(t('users'))}</h3><p>${escapeHtml(t('usersHelp'))}</p></div>
        <label class="admin-users-show-all">
          <input
            type="checkbox"
            role="switch"
            data-action="toggle-admin-show-all-users"
            aria-label="${escapeHtml(t('showAllUsers'))}"
            ${adminShowAllUsers ? 'checked' : ''}
          />
          <span>${escapeHtml(t('showAllUsers'))}</span>
        </label>
      </div>
      <div class="admin-users-toolbar">
        <form id="add-user-form" class="inline-form admin-add-user-form">
          <label class="field"><span>${escapeHtml(t('alias'))}</span><input name="alias" maxlength="40" placeholder="${escapeHtml(t('alias'))}" required autocomplete="off" /></label>
          <button type="submit" class="secondary-button">${escapeHtml(t('addUser'))}</button>
        </form>
        ${clearRemovedUsersButton}
      </div>
      <div class="table-wrap admin-users-table-wrap"><table class="admin-users-table">
        <thead><tr><th>${escapeHtml(t('user'))}</th><th>${escapeHtml(t('role'))}</th><th>${escapeHtml(t('ledgerSelectable'))}</th><th>${escapeHtml(t('status'))}</th><th>${escapeHtml(t('actions'))}</th></tr></thead>
        <tbody>${renderUserRows()}</tbody>
      </table></div>
    </section>`;
}

function renderAdminBackup() {
  const controlsDisabled = isBackupBusy || isClearingLedgerData;
  return `<section class="accounting-card admin-backup-card">
      <div class="card-heading">
        <div>
          <h3>${escapeHtml(t('backupData'))}</h3>
          <p>${escapeHtml(t('backupDataHelp'))}</p>
        </div>
      </div>
      <div class="admin-backup-actions">
        <button
          type="button"
          data-action="export-backup"
          ${controlsDisabled ? 'disabled' : ''}
        >${escapeHtml(t('exportBackup'))}</button>
        <input
          id="import-backup-input"
          type="file"
          accept=".zip,application/zip"
          hidden
        />
        <button
          class="secondary-button"
          type="button"
          data-action="import-backup"
          ${controlsDisabled ? 'disabled' : ''}
        >${escapeHtml(t('importBackup'))}</button>
      </div>
      <p
        class="backup-status${backupStatusType === 'error' ? ' backup-status-error' : ''}"
        role="${backupStatusType === 'error' ? 'alert' : 'status'}"
        aria-live="polite"
      >${escapeHtml(backupStatus)}</p>
    </section>`;
}

function renderAdminLedgerData() {
  return `<section class="accounting-card">
      <div class="card-heading">
        <div>
          <h3>${escapeHtml(t('ledgerData'))}</h3>
          <p>${escapeHtml(t('clearAllLedgerDataHelp'))}</p>
        </div>
      </div>
      <button
        class="secondary-button danger-text"
        type="button"
        data-action="clear-all-ledger-data"
        ${isClearingLedgerData || isBackupBusy ? 'disabled' : ''}
      >${escapeHtml(t(isClearingLedgerData ? 'clearingLedgerData' : 'clearAllLedgerData'))}</button>
    </section>`;
}

function renderHelpGuideItem(labels, messageKey) {
  const renderedLabels = labels
    .map((label) => (
      `<span class="help-control-label">${escapeHtml(label)}</span>`
    ))
    .join('');

  return `<li>
    <span class="help-control-labels">${renderedLabels}</span>
    <span>${escapeHtml(t(messageKey))}</span>
  </li>`;
}

function renderHelpGuideModal() {
  if (!showHelpGuide) return '';

  return `<div class="modal-overlay" data-action="close-help-guide" role="dialog" aria-modal="true" aria-labelledby="help-guide-heading">
    <div class="modal-card help-guide-modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <div class="modal-header-title">
          <span class="help-modal-icon">❓</span>
          <div>
            <h3 id="help-guide-heading">${escapeHtml(t('helpGuideTitle'))}</h3>
            <p class="modal-subtitle">${escapeHtml(t('helpGuideSubtitle'))}</p>
          </div>
        </div>
        <button type="button" class="modal-close-button" data-action="close-help-guide" aria-label="${escapeHtml(t('helpGuideClose'))}">&times;</button>
      </div>

      <div class="modal-body help-guide-content">
        <section class="help-guide-section">
          <h4>📌 ${escapeHtml(t('helpSectionNavigation'))}</h4>
          <ul class="help-guide-list">
            ${renderHelpGuideItem(
              [
                `➕ ${t('newEntry')}`,
                `📖 ${t('accounting')}`,
                `💱 ${t('conversionSettings')}`,
              ],
              'helpNavPrimary',
            )}
            ${renderHelpGuideItem(
              [
                '🌈🐱',
                t('shareInstall'),
              ],
              'helpNavShare',
            )}
            ${renderHelpGuideItem(
              [
                `👤 ${t('account')}`,
                t('language'),
                themeToggleLabel(),
              ],
              'helpNavAccount',
            )}
            ${renderHelpGuideItem(
              [
                '?',
              ],
              'helpNavHelp',
            )}
          </ul>
        </section>

        <section class="help-guide-section">
          <h4>🧾 ${escapeHtml(t('helpSectionExpense'))}</h4>
          <ul class="help-guide-list">
            ${renderHelpGuideItem(
              [
                t('addDebt'),
                t('saveEntry'),
              ],
              'helpExpenseCreate',
            )}
            ${renderHelpGuideItem(
              [
                '📷',
                t('uploadImage'),
                t('takePhoto'),
              ],
              'helpExpenseImages',
            )}
            ${renderHelpGuideItem(
              [
                t('editEntry'),
                t('clearEntry'),
                t('restoreEntry'),
                t('saveChanges'),
              ],
              'helpExpenseClear',
            )}
            ${renderHelpGuideItem(
              [
                t('clearAllDebts'),
                t('restoreAllDebts'),
              ],
              'helpExpenseClearAll',
            )}
          </ul>
        </section>

        <section class="help-guide-section">
          <h4>🧮 ${escapeHtml(t('helpSectionBalances'))}</h4>
          <ul class="help-guide-list">
            ${renderHelpGuideItem(
              [
                `${t('debtor')} → ${t('creditor')}`,
              ],
              'helpBalanceDirection',
            )}
            ${renderHelpGuideItem(
              [
                t('settlementBalances'),
              ],
              'helpBalanceNet',
            )}
            ${renderHelpGuideItem(
              [
                t('ledgerSearchPlaceholder'),
                '▶ / ▼',
                `${t('showLedger')} / ${t('hideLedger')}`,
              ],
              'helpBalanceVisibility',
            )}
            ${renderHelpGuideItem(
              [
                t('calculateSettlements'),
              ],
              'helpBalanceSettlement',
            )}
          </ul>
        </section>

        <section class="help-guide-section">
          <h4>💱 ${escapeHtml(t('helpSectionCurrency'))}</h4>
          <ul class="help-guide-list">
            ${renderHelpGuideItem(
              [
                t('conversionSettings'),
              ],
              'helpCurrencyPage',
            )}
            ${renderHelpGuideItem(
              [
                t('resultCurrency'),
              ],
              'helpCurrencyResult',
            )}
            ${renderHelpGuideItem(
              [
                '1 USD = 30 TWD',
              ],
              'helpCurrencyRate',
            )}
            ${renderHelpGuideItem(
              [
                '↻',
                t('save'),
              ],
              'helpCurrencyRefresh',
            )}
          </ul>
        </section>
      </div>

      <div class="modal-footer">
        <button type="button" class="primary-button" data-action="close-help-guide">${escapeHtml(t('helpGuideClose'))}</button>
      </div>
    </div>
  </div>`;
}

function renderApplication() {
  const content = selectedLedgerImageEntryId
    ? renderLedgerImageViewer()
    : activeView === 'account'
      ? renderAccount()
      : activeView === 'share'
        ? renderShare()
        : activeView === 'add-entry'
          ? renderNewEntry()
          : activeView === 'conversion'
            ? renderConversion()
            : renderLedger();

  root.innerHTML = `<main class="app-shell">
    <aside class="side-panel">
      ${brand()}
      <section class="profile-summary${activeView === 'account' ? ' chosen' : ''}" role="button" tabindex="0" data-view="account" aria-label="${escapeHtml(t('account'))}">
        ${renderUserAvatar(profile)}
        <div><strong>${escapeHtml(userAlias(profile))}</strong></div>
      </section>
    </aside>
    <nav class="app-nav" aria-label="${escapeHtml(t('applicationNavigation'))}">
      <div>
        ${navigationItem('add-entry', '➕', t('newEntry'))}
        ${navigationItem('ledger', '📖', t('accounting'))}
        ${navigationItem('conversion', '💱', t('conversionSettings'))}
      </div>
      ${appVersion ? `<p class="app-version">${escapeHtml(appVersion)}</p>` : ''}
    </nav>
    <section class="content-panel">
      <button class="help-guide-button" type="button" data-action="toggle-help-guide" title="${escapeHtml(t('helpGuideTitle'))}" aria-label="${escapeHtml(t('helpGuideTitle'))}">?</button>
      ${notice ? `<p class="notice notice-${noticeType}" role="${noticeType === 'error' ? 'alert' : 'status'}">${escapeHtml(notice)}</p>` : ''}
      ${content}
      ${renderHelpGuideModal()}
    </section>
  </main>`;
  bind();
  finishInitialLoading();
  if (activeView === 'share') void renderShareQr();
}

function render() {
  if (!authUser) {
    root.innerHTML = authFrame(`
      <h2>${escapeHtml(t('loginHeading'))}</h2>
      <p class="muted">${escapeHtml(t('loginHelp'))}</p>
      <button class="google-login-button" type="button" data-action="login">
        <svg class="google-login-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
          <path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844c-.209 1.125-.842 2.078-1.796 2.716v2.258h2.909c1.702-1.567 2.683-3.874 2.683-6.614Z" />
          <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.181l-2.909-2.258c-.806.54-1.837.859-3.047.859-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A9 9 0 0 0 9 18Z" />
          <path fill="#FBBC05" d="M3.963 10.706A5.41 5.41 0 0 1 3.682 9c0-.591.102-1.166.281-1.706V4.962H.956A9 9 0 0 0 0 9c0 1.452.348 2.827.956 4.038l3.007-2.332Z" />
          <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.442 1.345l2.581-2.581C13.463.891 11.43 0 9 0a9 9 0 0 0-8.044 4.962l3.007 2.332C4.672 5.165 6.656 3.58 9 3.58Z" />
        </svg>
        <span>${escapeHtml(t('login'))}</span>
      </button>
      ${appVersion ? `<p class="app-version" style="margin-top: 2rem; font-size: 0.875rem; opacity: 0.6;">${escapeHtml(appVersion)}</p>` : ''}
    `);
    bind();
    finishInitialLoading();
    return;
  }

  if (!profile) {
    root.innerHTML = authFrame(`<p class="loading-copy">${escapeHtml(t('loading'))}</p>`);
    bind();
    return;
  }

  if (profile.status === 'registration') {
    renderRegistration();
    return;
  }

  if (!isActiveUser(profile)) {
    renderPending();
    return;
  }

  renderApplication();
}

function bindLedgerFilter() {
  const filterInput = document.querySelector('#ledger-filter');
  const clearBtn = document.querySelector('[data-action="clear-ledger-filter"]');
  if (!filterInput) return;

  const updateClearVisibility = () => {
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', filterInput.value.length === 0);
    }
  };

  filterInput.addEventListener('input', (event) => {
    ledgerFilter = event.currentTarget.value;
    updateClearVisibility();
    if (!event.isComposing) refreshLedgerRows();
  });
  filterInput.addEventListener('compositionend', (event) => {
    ledgerFilter = event.currentTarget.value;
    updateClearVisibility();
    refreshLedgerRows();
  });
}

function bindLedgerRows() {
  const ledgerEditForm = document.querySelector('#ledger-edit-form');
  ledgerEditForm?.addEventListener('submit', updateLedgerEntry);
  ledgerEditForm?.addEventListener('input', () => {
    captureLedgerEditDraft(ledgerEditForm);
  });
  ledgerEditForm?.addEventListener('change', () => {
    captureLedgerEditDraft(ledgerEditForm);
    updateLedgerSplitInheritedValues(
      ledgerEditForm,
      ledgerEditDraft?.creditorId,
      ledgerEditDraft?.currency,
    );
  });
  document.querySelectorAll('[data-edit-entry]').forEach((button) => {
    button.onclick = () => {
      const entryId = button.dataset.editEntry;
      const entry = ledgerEntryById(entryId);
      if (!entry || !canManageEntry(entry)) return;
      revokePendingLedgerEntryImages(ledgerEntryImageKey(entryId));
      editingLedgerEntryId = entryId;
      ledgerEditDraft = createLedgerEditDraft(entry);
      selectedLedgerImageEntryId = '';
      selectedLedgerImageIndex = 0;
      notice = '';
      render();
    };
  });
  document.querySelectorAll('[data-cancel-edit-entry]').forEach((button) => {
    button.onclick = () => {
      revokePendingLedgerEntryImages(
        ledgerEntryImageKey(button.dataset.cancelEditEntry),
      );
      discardLedgerEditDraft();
      render();
    };
  });
  document.querySelectorAll('[data-add-edit-split]').forEach((button) => {
    button.onclick = () => addLedgerSplitDraft(ledgerEditForm);
  });
  document.querySelectorAll('[data-toggle-edit-split]').forEach((button) => {
    button.onclick = () => toggleLedgerSplitDraft(
      ledgerEditForm,
      button.dataset.toggleEditSplit,
    );
  });
  document.querySelectorAll('[data-delete-edit-split]').forEach((button) => {
    button.onclick = () => removeLedgerSplitDraft(
      ledgerEditForm,
      button.dataset.deleteEditSplit,
    );
  });
  document.querySelectorAll('[data-delete-entry]').forEach((button) => {
    button.onclick = () => {
      if (confirm(t('deleteEntryConfirm'))) {
        void removeLedgerEntry(button.dataset.deleteEntry);
      }
    };
  });
  document.querySelectorAll('[data-toggle-clear-entry]').forEach((button) => {
    button.onclick = () => {
      void toggleAllLedgerSplitsCleared(button.dataset.toggleClearEntry);
    };
  });
  document.querySelectorAll('[data-view-ledger-image]').forEach((button) => {
    button.onclick = () => {
      const newEntryForm = button.closest('#ledger-form');
      const editForm = button.closest('#ledger-edit-form');
      if (newEntryForm) captureLedgerNewDraft(newEntryForm);
      if (editForm) captureLedgerEditDraft(editForm);
      selectedLedgerImageEntryId = button.dataset.viewLedgerImage;
      selectedLedgerImageIndex = 0;
      if (!newEntryForm && !editForm) {
        discardLedgerEditDraft();
      }
      render();
    };
  });
  document.querySelectorAll('[data-toggle-row-meta]').forEach((button) => {
    button.onclick = () => {
      const entryId = button.dataset.toggleRowMeta;
      const footer = button.closest('.ledger-group')?.querySelector('.ledger-group-footer');
      if (ledgerExpandedFooters.has(entryId)) {
        ledgerExpandedFooters.delete(entryId);
      } else {
        ledgerExpandedFooters.add(entryId);
      }
      persistLedgerExpandedFooters();
      const expanded = ledgerExpandedFooters.has(entryId);
      footer?.classList.toggle('ledger-group-footer-collapsed', !expanded);
      button.setAttribute('aria-expanded', String(expanded));
      button.title = expanded ? t('hideEntryDetails') : t('showEntryDetails');
      button.textContent = expanded ? '▼' : '▶';
    };
  });
  bindLedgerAmountInputs(ledgerEditForm);
}

function bind() {
  document.querySelectorAll('[data-action="login"]').forEach((button) => {
    button.onclick = () => signInWithPopup(auth, google).catch(reportError);
  });
  document.querySelectorAll('[data-action="signout"]').forEach((button) => {
    button.onclick = () => signOut(auth).catch(reportError);
  });
  document.querySelectorAll('[data-action="locale"]').forEach((button) => {
    button.onclick = () => {
      toggleLocale();
      render();
    };
  });
  document.querySelectorAll('[data-action="theme"]').forEach((button) => {
    button.onclick = () => {
      const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = nextTheme;
      localStorage.setItem('nyan-split-theme', nextTheme);
      document.querySelector('meta[name="theme-color"]')?.setAttribute(
        'content',
        nextTheme === 'dark' ? '#0b0a16' : '#f8f6ff',
      );
      render();
    };
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.onclick = () => {
      clearAllPendingLedgerEntryImages();
      activeView = button.dataset.view;
      closeLedgerImageViewer();
      discardLedgerEditDraft();
      discardLedgerNewDraft();
      notice = '';
      render();
    };
  });
  document.querySelectorAll('[data-view][role="button"]').forEach((control) => {
    control.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        control.click();
      }
    };
  });
  document.querySelector('#registration-form')?.addEventListener('submit', completeRegistration);
  document.querySelector('#account-form')?.addEventListener('submit', saveAccount);
  document.querySelector('#add-user-form')?.addEventListener('submit', addAdminUser);
  const ledgerForm = document.querySelector('#ledger-form');
  ledgerForm?.addEventListener('submit', addLedgerEntry);
  ledgerForm?.addEventListener('input', () => {
    captureLedgerNewDraft(ledgerForm);
  });
  ledgerForm?.addEventListener('change', () => {
    captureLedgerNewDraft(ledgerForm);
    updateLedgerSplitInheritedValues(
      ledgerForm,
      ledgerNewDraft?.creditorId,
      ledgerNewDraft?.currency,
    );
  });
  ledgerForm?.elements.creditorId?.addEventListener(
    'change',
    updateNewEntryCreditor,
  );
  document.querySelectorAll('[data-add-new-split]').forEach((button) => {
    button.onclick = () => addNewLedgerSplitDraft(ledgerForm);
  });
  document.querySelectorAll('[data-remove-new-split]').forEach((button) => {
    button.onclick = () => removeNewLedgerSplitDraft(
      ledgerForm,
      button.dataset.removeNewSplit,
    );
  });
  bindLedgerAmountInputs(ledgerForm);
  bindLedgerFilter();
  bindLedgerRows();
  document.querySelector('#currency-result-currency')?.addEventListener('change', (event) => {
    const resultCurrency = normalizeCurrency(event.currentTarget.value);
    if (!isAllowedCurrency(resultCurrency)) return;
    pendingResultCurrency = resultCurrency;
    pendingCurrencyRateDraft = null;
    render();
  });
  document.querySelector('#currency-conversion-form')?.addEventListener('submit', saveCurrencyConversion);
  document.querySelectorAll('[data-currency-rate-input]').forEach((input) => {
    input.addEventListener('input', (event) => captureCurrencyRateDraft(event.currentTarget.form));
  });
  document.querySelectorAll('[data-refresh-currency-rate]').forEach((button) => {
    button.onclick = () => refreshPublicRateForCurrency(button.dataset.refreshCurrencyRate);
  });
  document.querySelector('#app-settings-form')?.addEventListener('submit', saveAppSettings);
  document.querySelector('#app-settings-default-currency')?.addEventListener('change', updateAdminDefaultCurrency);
  document.querySelector('[data-action="add-allowed-currency"]')?.addEventListener('click', addAllowedCurrency);
  document.querySelector('#allowed-currency-code')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addAllowedCurrency();
    }
  });
  document.querySelectorAll('[data-remove-allowed-currency]').forEach((button) => {
    button.onclick = () => removeAllowedCurrency(button.dataset.removeAllowedCurrency);
  });
  document.querySelectorAll('[data-user-status]').forEach((button) => {
    button.onclick = () => updateUserStatus(button.dataset.userId, button.dataset.userStatus);
  });
  document.querySelectorAll('[data-user-role]').forEach((select) => {
    select.onchange = () => updateUserRole(
      select.dataset.userRole,
      select.value,
    );
  });
  document.querySelectorAll('[data-user-ledger-selectable]').forEach((input) => {
    input.onchange = () => updateUserLedgerSelectable(
      input.dataset.userLedgerSelectable,
      input.checked,
    );
  });
  document.querySelectorAll('[data-user-disabled]').forEach((button) => {
    button.onclick = () => updateUserDisabled(
      button.dataset.userId,
      button.dataset.userDisabled === 'true',
    );
  });
  document.querySelectorAll('[data-remove-user]').forEach((button) => {
    button.onclick = () => removeUser(button.dataset.removeUser);
  });
  document.querySelector('[data-action="toggle-admin-show-all-users"]')?.addEventListener('change', (event) => {
    adminShowAllUsers = event.currentTarget.checked;
    localStorage.setItem('nyan-split-admin-show-all-users', adminShowAllUsers);
    render();
  });
  document.querySelector('[data-action="clear-removed-users"]')?.addEventListener(
    'click',
    clearRemovedUsers,
  );
  document.querySelector('[data-action="export-backup"]')?.addEventListener(
    'click',
    exportLedgerBackup,
  );
  document.querySelector('[data-action="import-backup"]')?.addEventListener('click', () => {
    document.querySelector('#import-backup-input')?.click();
  });
  document.querySelector('#import-backup-input')?.addEventListener('change', (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) void importLedgerBackup(file);
  });
  document.querySelector('[data-action="clear-all-ledger-data"]')?.addEventListener(
    'click',
    clearAllLedgerData,
  );
  document.querySelector('.ledger-image-view')?.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="ledger-image-prev"]:not([disabled])')) {
      if (selectedLedgerImageIndex > 0) {
        selectedLedgerImageIndex -= 1;
        render();
      }
      return;
    }
    if (event.target.closest('[data-action="ledger-image-next"]:not([disabled])')) {
      const images = ledgerViewerImages(selectedLedgerImageEntryId);
      if (selectedLedgerImageIndex < images.length - 1) {
        selectedLedgerImageIndex += 1;
        render();
      }
    }
  });
  document.querySelector('#ledger-image-upload')?.addEventListener('change', (event) => {
    const files = event.currentTarget.files;
    event.currentTarget.value = '';
    if (files?.length) void handleLedgerImageFiles(selectedLedgerImageEntryId, files);
  });
  document.querySelector('#ledger-image-camera')?.addEventListener('change', (event) => {
    const files = event.currentTarget.files;
    event.currentTarget.value = '';
    if (files?.length) void handleLedgerImageFiles(selectedLedgerImageEntryId, files);
  });
  document.querySelectorAll('[data-delete-ledger-image]').forEach((button) => {
    button.onclick = () => removeViewerLedgerImage(button.dataset.deleteLedgerImage);
  });
  document.querySelector('[data-action="back-from-ledger-image"]')?.addEventListener('click', () => {
    const wasNewEntry = selectedLedgerImageEntryId === NEW_LEDGER_ENTRY_IMAGE_KEY;
    closeLedgerImageViewer();
    if (wasNewEntry) {
      activeView = 'add-entry';
    } else if (!editingLedgerEntryId) {
      activeView = 'ledger';
    }
    render();
  });
  document.querySelector('[data-action="copy-share-url"]')?.addEventListener('click', copyShareUrl);
  document.querySelector('[data-action="install-app"]')?.addEventListener('click', installApp);
  document.querySelector('[data-action="calculate-settlements"]')?.addEventListener(
    'click',
    calculateSuggestedTransfers,
  );
  document.querySelector('[data-action="clear-ledger-filter"]')?.addEventListener('click', () => {
    ledgerFilter = '';
    const filterInput = document.querySelector('#ledger-filter');
    if (filterInput) filterInput.value = '';
    const clearBtn = document.querySelector('[data-action="clear-ledger-filter"]');
    if (clearBtn) clearBtn.classList.add('hidden');
    refreshLedgerRows();
  });
  document.querySelector('[data-action="toggle-ledger-collapse"]')?.addEventListener('click', (event) => {
    ledgerCollapsed = !ledgerCollapsed;
    localStorage.setItem('nyan-split-ledger-collapsed', ledgerCollapsed);
    const button = event.currentTarget;
    const rows = document.querySelector('#ledger-rows');
    if (rows) rows.classList.toggle('ledger-list-collapsed', ledgerCollapsed);
    button.setAttribute('aria-expanded', String(!ledgerCollapsed));
    button.title = ledgerCollapsed ? t('showLedger') : t('hideLedger');
    button.textContent = ledgerCollapsed ? '▶' : '▼';
  });
  document.querySelectorAll('[data-action="toggle-help-guide"]').forEach((button) => {
    button.onclick = () => {
      showHelpGuide = !showHelpGuide;
      render();
    };
  });
  document.querySelectorAll('[data-action="close-help-guide"]').forEach((element) => {
    element.onclick = (event) => {
      if (event.target === element || element.tagName === 'BUTTON') {
        showHelpGuide = false;
        render();
      }
    };
  });
  document.onkeydown = (event) => {
    if (event.key === 'Escape') {
      if (showHelpGuide) {
        showHelpGuide = false;
        render();
      } else if (selectedLedgerImageEntryId) {
        const wasNewEntry = selectedLedgerImageEntryId === NEW_LEDGER_ENTRY_IMAGE_KEY;
        closeLedgerImageViewer();
        if (wasNewEntry) {
          activeView = 'add-entry';
        } else if (!editingLedgerEntryId) {
          activeView = 'ledger';
        }
        render();
      }
    }
  };
}

async function renderShareQr() {
  const image = document.querySelector('#share-qr');
  const url = image?.dataset.shareUrl;
  if (!image || !url) return;

  try {
    const dataUrl = await QRCode.toDataURL(url, {
      color: {
        dark: '#141225',
        light: '#ffffffff',
      },
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 280,
    });
    if (document.querySelector('#share-qr') !== image) return;
    image.src = dataUrl;
    image.hidden = false;
  } catch (error) {
    console.warn('Could not generate the share QR code.', error);
    setErrorNotice(t('qrFailed'));
  }
}

async function copyShareUrl() {
  const input = document.querySelector('#share-url');
  const url = input?.value || shareUrl();
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    input?.focus();
    input?.select();
    if (!document.execCommand('copy')) {
      setErrorNotice(t('copyFailed'));
      return;
    }
  }
  setNotice(t('copied'));
}

async function installApp() {
  if (!deferredInstallPrompt) {
    setNotice(t('installHelp'));
    return;
  }

  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  setNotice(choice.outcome === 'accepted' ? t('installStarted') : t('installDismissed'));
}

async function ensureGoogleAuthVerification(user) {
  if (!authUserHasGoogleIdentity(user)) return;

  try {
    await setDoc(doc(db, 'userAuth', user.uid), {
      provider: GOOGLE_PROVIDER_ID,
    });
  } catch (error) {
    console.warn('Could not verify the Google sign-in provider.', error);
  }
}

async function completeRegistration(event) {
  event.preventDefault();
  try {
    const alias = cleanAlias(new FormData(event.currentTarget).get('alias')) || defaultAlias();
    await setDoc(doc(db, 'users', authUser.uid), {
      alias,
      disabled: false,
      email: authUser.email || '',
      ledgerSelectable: true,
      photoURL: authUser.photoURL || '',
      resultCurrency: settings.defaultCurrency || DEFAULT_CURRENCY,
      role: 'user',
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    notice = '';
  } catch (error) {
    reportError(error);
  }
}

async function addAdminUser(event) {
  event.preventDefault();
  try {
    const form = event.currentTarget;
    const alias = cleanAlias(new FormData(form).get('alias'));
    if (!alias) {
      setErrorNotice(t('aliasRequired'));
      return;
    }
    await setDoc(doc(collection(db, 'users')), {
      alias,
      disabled: false,
      email: '',
      ledgerSelectable: true,
      photoURL: '',
      resultCurrency: currentAdminCurrencySettings().defaultCurrency,
      role: 'user',
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    form.reset();
  } catch (error) {
    reportError(error);
  }
}

async function saveAccount(event) {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    const alias = cleanAlias(form.get('alias'));
    if (!alias) {
      setErrorNotice(t('aliasRequired'));
      return;
    }
    await updateDoc(doc(db, 'users', profile.uid), {
      alias,
      updatedAt: serverTimestamp(),
    });
    setNotice(t('accountSaved'));
  } catch (error) {
    reportError(error);
  }
}

async function saveCurrencyConversion(event) {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    const resultCurrency = normalizeCurrency(form.get('resultCurrency'));
    if (!isAllowedCurrency(resultCurrency)) {
      setErrorNotice(t('currencyNotAllowed'));
      return;
    }

    const currencyRates = {};
    for (const currency of settings.allowedCurrencies) {
      if (currency === resultCurrency) continue;
      const rawRate = String(form.get(`currencyRate-${currency}`) || '').trim();
      if (!rawRate) continue;

      const rate = Number(rawRate);
      if (!isPositiveRate(rate)) {
        setErrorNotice(t('currencyRateInvalid', { currency }));
        return;
      }
      currencyRates[currency] = rate;
    }

    await updateDoc(doc(db, 'users', profile.uid), {
      resultCurrency,
      currencyRates,
      updatedAt: serverTimestamp(),
    });
    pendingResultCurrency = '';
    pendingCurrencyRateDraft = null;
    setNotice(t('currencySettingsSaved'));
  } catch (error) {
    reportError(error);
  }
}

async function addLedgerEntry(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  try {
    normalizeLedgerFormAmountFields(formElement);
    captureLedgerNewDraft(formElement);
    if (!ledgerNewDraft) return;

    const creditorId = String(ledgerNewDraft.creditorId || '');
    const currency = normalizeCurrency(ledgerNewDraft.currency);
    const note = String(ledgerNewDraft.note || '').trim();
    const normalizedSplits = ledgerNewDraft.splits.map((split) => ({
      amount: resolveLedgerAmountInput(split.amount),
      debtorId: String(split.debtorId || ''),
    }));
    const imageKey = ledgerEntryImageKey();
    const imageFiles = pendingLedgerEntryImageFiles(imageKey);
    if (!normalizedSplits.length) {
      setErrorNotice(t('atLeastOneDebt'));
      return;
    }
    if (normalizedSplits.length > MAX_LEDGER_SPLITS) {
      setErrorNotice(t('maximumDebts', { max: MAX_LEDGER_SPLITS }));
      return;
    }
    if (
      !creditorId
      || normalizedSplits.some((split) => (
        !split.debtorId
        || split.debtorId === creditorId
      ))
    ) {
      setErrorNotice(t('differentPeople'));
      return;
    }
    if (
      !selectableUserById(creditorId)
      || normalizedSplits.some(
        (split) => !selectableUserById(split.debtorId),
      )
    ) {
      setErrorNotice(t('ledgerParticipantUnavailable'));
      return;
    }
    if (ledgerNoteCharacterCount(note) > MAX_LEDGER_NOTE_LENGTH) {
      setErrorNotice(t('noteTooLong', { max: MAX_LEDGER_NOTE_LENGTH }));
      return;
    }
    if (normalizedSplits.some((split) => (
      !Number.isFinite(split.amount)
      || split.amount <= 0
    ))) {
      setErrorNotice(t('amountPositive'));
      return;
    }
    if (normalizedSplits.some((split) => !isValidLedgerAmount(split.amount))) {
      setErrorNotice(t('amountTooLarge', { max: MAX_LEDGER_AMOUNT_INTEGER_DIGITS }));
      return;
    }
    const normalizedNote = normalizeLedgerNote(note);
    const debtorIds = normalizedSplits.map((split) => split.debtorId);
    if (new Set(debtorIds).size !== debtorIds.length) {
      setErrorNotice(t('duplicateDebtor'));
      return;
    }
    if (!isAllowedCurrency(currency)) {
      setErrorNotice(t('currencyNotAllowed'));
      return;
    }

    if (imageFiles.some((file) => (
      !(file instanceof File)
      || !file.type.startsWith('image/')
    ))) {
      setErrorNotice(t('imageUnsupported'));
      return;
    }

    let imageDataUrls = [];
    if (imageFiles.length) {
      try {
        imageDataUrls = await compressLedgerImageFiles(imageFiles);
      } catch (error) {
        revokePendingLedgerEntryImages(imageKey);
        reportLedgerImageError(error);
        return;
      }
    }

    const ledgerReference = doc(collection(db, 'ledger'));
    const batch = writeBatch(db);
    batch.set(ledgerReference, {
      creditorId,
      createdAt: serverTimestamp(),
      createdBy: profile.uid,
      currency,
      note: normalizedNote,
      updatedAt: serverTimestamp(),
    });

    normalizedSplits.forEach((split, position) => {
      const splitReference = doc(
        db,
        'ledgerSplits',
        ledgerSplitDocumentId(ledgerReference.id, split.debtorId),
      );
      batch.set(splitReference, {
        amount: split.amount,
        cleared: false,
        createdAt: serverTimestamp(),
        debtorId: split.debtorId,
        ledgerId: ledgerReference.id,
        position,
        updatedAt: serverTimestamp(),
      });
    });

    imageDataUrls.forEach((imageDataUrl) => {
      const imageReference = doc(collection(db, 'ledgerImages'));
      batch.set(imageReference, {
        createdAt: serverTimestamp(),
        createdBy: profile.uid,
        dataUrl: imageDataUrl,
        ledgerId: ledgerReference.id,
      });
    });

    await batch.commit();
    revokePendingLedgerEntryImages(imageKey);
    discardLedgerNewDraft();
    activeView = 'ledger';
    setNotice(t('entryAdded'));
  } catch (error) {
    reportError(error);
  }
}

async function updateLedgerEntry(event) {
  event.preventDefault();
  try {
    const entry = ledgerEntryById(editingLedgerEntryId);
    if (
      !entry
      || !canManageEntry(entry)
      || ledgerEditDraft?.entryId !== entry.id
    ) return;

    normalizeLedgerFormAmountFields(event.currentTarget);
    captureLedgerEditDraft(event.currentTarget);
    const currency = normalizeCurrency(ledgerEditDraft.currency);
    const note = String(ledgerEditDraft.note || '').trim();
    const originalSplitIds = new Set(ledgerEditDraft.originalSplitIds);
    const normalizedSplits = ledgerEditDraft.splits.map((split) => {
      const debtorId = String(split.debtorId || '');
      const expectedSplitId = ledgerSplitDocumentId(entry.id, debtorId);
      return {
        ...split,
        amount: resolveLedgerAmountInput(split.amount),
        debtorId,
        id: split.id || (originalSplitIds.has(expectedSplitId)
          ? expectedSplitId
          : ''),
      };
    });
    const imageKey = ledgerEntryImageKey(entry.id);
    const imageFiles = pendingLedgerEntryImageFiles(imageKey);
    if (!normalizedSplits.length) {
      setErrorNotice(t('atLeastOneDebt'));
      return;
    }
    if (normalizedSplits.length > MAX_LEDGER_SPLITS) {
      setErrorNotice(t('maximumDebts', { max: MAX_LEDGER_SPLITS }));
      return;
    }
    if (normalizedSplits.some((split) => (
      !split.debtorId
      || split.debtorId === entry.creditorId
    ))) {
      setErrorNotice(t('differentPeople'));
      return;
    }
    const newSplits = normalizedSplits.filter((split) => !split.id);
    if (
      newSplits.length
      && (
        !selectableUserById(entry.creditorId)
        || newSplits.some(
          (split) => !selectableUserById(split.debtorId),
        )
      )
    ) {
      setErrorNotice(t('ledgerParticipantUnavailable'));
      return;
    }
    if (ledgerNoteCharacterCount(note) > MAX_LEDGER_NOTE_LENGTH) {
      setErrorNotice(t('noteTooLong', { max: MAX_LEDGER_NOTE_LENGTH }));
      return;
    }
    if (normalizedSplits.some((split) => (
      !Number.isFinite(split.amount)
      || split.amount <= 0
    ))) {
      setErrorNotice(t('amountPositive'));
      return;
    }
    if (normalizedSplits.some((split) => !isValidLedgerAmount(split.amount))) {
      setErrorNotice(t('amountTooLarge', { max: MAX_LEDGER_AMOUNT_INTEGER_DIGITS }));
      return;
    }
    const normalizedNote = normalizeLedgerNote(note);
    const debtorIds = normalizedSplits.map((split) => split.debtorId);
    if (new Set(debtorIds).size !== debtorIds.length) {
      setErrorNotice(t('duplicateDebtor'));
      return;
    }
    if (!isAllowedCurrency(currency)) {
      setErrorNotice(t('currencyNotAllowed'));
      return;
    }

    if (imageFiles.some((file) => (
      !(file instanceof File)
      || !file.type.startsWith('image/')
    ))) {
      setErrorNotice(t('imageUnsupported'));
      return;
    }

    let imageDataUrls = [];
    if (imageFiles.length) {
      try {
        imageDataUrls = await compressLedgerImageFiles(imageFiles);
      } catch (error) {
        revokePendingLedgerEntryImages(imageKey);
        reportLedgerImageError(error);
        return;
      }
    }

    const batch = writeBatch(db);
    batch.update(doc(db, 'ledger', entry.id), {
      currency,
      note: normalizedNote,
      updatedAt: serverTimestamp(),
    });

    const retainedSplitIds = new Set(
      normalizedSplits
        .map((split) => split.id)
        .filter(Boolean),
    );
    ledgerEditDraft.originalSplitIds
      .filter((splitId) => !retainedSplitIds.has(splitId))
      .forEach((splitId) => {
        batch.delete(doc(db, 'ledgerSplits', splitId));
      });

    normalizedSplits.forEach((split, position) => {
      const splitId = ledgerSplitDocumentId(entry.id, split.debtorId);
      const splitReference = doc(db, 'ledgerSplits', splitId);
      if (split.id) {
        if (split.id !== splitId) {
          throw new Error('An existing debt cannot change its owing user.');
        }
        batch.update(splitReference, {
          amount: split.amount,
          cleared: Boolean(split.cleared),
          position,
          updatedAt: serverTimestamp(),
        });
        return;
      }
      batch.set(splitReference, {
        amount: split.amount,
        cleared: Boolean(split.cleared),
        createdAt: serverTimestamp(),
        debtorId: split.debtorId,
        ledgerId: entry.id,
        position,
        updatedAt: serverTimestamp(),
      });
    });

    imageDataUrls.forEach((imageDataUrl) => {
      const imageReference = doc(collection(db, 'ledgerImages'));
      batch.set(imageReference, {
        createdAt: serverTimestamp(),
        createdBy: profile.uid,
        dataUrl: imageDataUrl,
        ledgerId: entry.id,
      });
    });

    await batch.commit();
    revokePendingLedgerEntryImages(imageKey);
    discardLedgerEditDraft();
    setNotice(t('entryUpdated'));
  } catch (error) {
    reportError(error);
  }
}

async function addLedgerImage(entryId, file, entry = ledgerEntryById(entryId)) {
  if (!entry || !canManageEntry(entry)) return false;
  if (!file.type.startsWith('image/')) {
    setErrorNotice(t('imageUnsupported'));
    return false;
  }

  try {
    const dataUrl = await compressLedgerImage(file);
    const imageReference = doc(collection(db, 'ledgerImages'));
    await setDoc(imageReference, {
      createdAt: serverTimestamp(),
      createdBy: profile.uid,
      dataUrl,
      ledgerId: entryId,
    });
    pendingLedgerImageFocus = {
      entryId,
      imageId: imageReference.id,
    };
    setNotice(t('imageAdded'));
    return true;
  } catch (error) {
    reportLedgerImageError(error);
    return false;
  }
}

async function handleLedgerImageFiles(viewerEntryId, files) {
  if (!viewerEntryId) return;
  const fileList = Array.from(files || []).filter((file) => file.size > 0);
  if (!fileList.length) return;

  if (shouldUsePendingLedgerImages(viewerEntryId)) {
    const pendingKey = ledgerImageViewerPendingKey(viewerEntryId);
    if (!addPendingLedgerEntryImages(pendingKey, fileList)) return;
    selectedLedgerImageIndex = ledgerViewerImages(viewerEntryId).length - 1;
    setNotice(t('imageAdded'));
    render();
    return;
  }

  for (const file of fileList) {
    const added = await addLedgerImage(viewerEntryId, file);
    if (!added) break;
  }
}

function removeViewerLedgerImage(imageId) {
  const viewerEntryId = selectedLedgerImageEntryId;
  if (!viewerEntryId || !imageId) return;

  if (imageId.startsWith('pending:')) {
    const pendingKey = ledgerImageViewerPendingKey(viewerEntryId);
    const pendingIndex = Number(imageId.slice('pending:'.length));
    if (!Number.isInteger(pendingIndex)) return;
    if (!window.confirm(t('deleteImageConfirm'))) return;
    if (!removePendingLedgerEntryImage(pendingKey, pendingIndex)) return;
    const total = ledgerViewerImages(viewerEntryId).length;
    if (selectedLedgerImageIndex >= total) {
      selectedLedgerImageIndex = Math.max(0, total - 1);
    }
    setNotice(t('imageRemoved'));
    render();
    return;
  }

  void removeLedgerImage(imageId);
}

async function removeLedgerImage(imageId) {
  const entryId = selectedLedgerImageEntryId;
  const entry = ledgerEntryById(entryId);
  if (!entry || !canManageEntry(entry)) return;

  const images = ledgerImagesForEntry(entryId);
  const imageIndex = images.findIndex((image) => image.id === imageId);
  if (imageIndex === -1) return;
  if (!window.confirm(t('deleteImageConfirm'))) return;

  try {
    await deleteDoc(doc(db, 'ledgerImages', imageId));
    if (selectedLedgerImageIndex >= images.length - 1) {
      selectedLedgerImageIndex = Math.max(0, images.length - 2);
    }
    setNotice(t('imageRemoved'));
  } catch (error) {
    reportError(error);
  }
}

function updateAdminDefaultCurrency(event) {
  const defaultCurrency = normalizeCurrency(event.currentTarget.value);
  const adminSettings = currentAdminCurrencySettings();
  if (!adminSettings.allowedCurrencies.includes(defaultCurrency)) return;
  adminCurrencySettings = {
    ...adminSettings,
    defaultCurrency,
  };
}

function addAllowedCurrency() {
  const input = document.querySelector('#allowed-currency-code');
  const currency = normalizeCurrency(input?.value);
  if (!currency) {
    input?.focus();
    setErrorNotice(t('currencyCodeInvalid'));
    return;
  }

  const adminSettings = currentAdminCurrencySettings();
  if (adminSettings.allowedCurrencies.includes(currency)) {
    setErrorNotice(t('currencyAlreadyAllowed', { currency }));
    return;
  }

  adminCurrencySettings = {
    ...adminSettings,
    allowedCurrencies: [
      ...adminSettings.allowedCurrencies,
      currency,
    ],
  };
  render();
}

function removeAllowedCurrency(currency) {
  const adminSettings = currentAdminCurrencySettings();
  if (currency === adminSettings.defaultCurrency) {
    setErrorNotice(t('cannotRemoveDefaultCurrency', { currency }));
    return;
  }
  if (!ledgerEntriesReady) {
    setErrorNotice(t('loading'));
    return;
  }
  const usedCurrency = findUsedLedgerCurrency([
    currency,
  ]);
  if (usedCurrency) {
    setErrorNotice(t('cannotRemoveUsedCurrency', {
      currency: usedCurrency,
    }));
    return;
  }

  adminCurrencySettings = {
    ...adminSettings,
    allowedCurrencies: adminSettings.allowedCurrencies.filter((item) => item !== currency),
  };
  render();
}

async function saveAppSettings(event) {
  event.preventDefault();
  try {
    const defaultCurrency = normalizeCurrency(
      new FormData(event.currentTarget).get('defaultCurrency'),
    );
    const adminSettings = currentAdminCurrencySettings();
    const allowedCurrencies = normalizeAllowedCurrencies(adminSettings.allowedCurrencies);
    if (!allowedCurrencies.includes(defaultCurrency)) {
      setErrorNotice(t('currencyNotAllowed'));
      return;
    }
    const removedCurrencies = settings.allowedCurrencies.filter(
      (currency) => !allowedCurrencies.includes(currency),
    );
    if (removedCurrencies.length) {
      const latestLedgerSnapshot = await getDocsFromServer(
        collection(db, 'ledger'),
      );
      const latestLedgerEntries = latestLedgerSnapshot.docs.map(
        (item) => item.data(),
      );
      const usedCurrency = findUsedLedgerCurrency(
        removedCurrencies,
        latestLedgerEntries,
      );
      if (usedCurrency) {
        setErrorNotice(t('cannotRemoveUsedCurrency', {
          currency: usedCurrency,
        }));
        return;
      }
    }
    await setDoc(settingsReference, {
      defaultCurrency,
      allowedCurrencies,
      updatedAt: serverTimestamp(),
      updatedBy: profile.uid,
    }, { merge: true });
    adminCurrencySettings = null;
    setNotice(t('defaultCurrencySaved'));
  } catch (error) {
    reportError(error);
  }
}

async function updateUserStatus(userId, status) {
  try {
    const user = managedUsers.find((item) => item.id === userId);
    if (
      !currentUserIsAdmin()
      || !user
      || userId === profile.uid
      || ![
        'active',
        'rejected',
      ].includes(status)
    ) {
      return;
    }
    await updateDoc(doc(db, 'users', userId), {
      ...(status === 'active' ? { disabled: false } : {}),
      status,
      updatedAt: serverTimestamp(),
    });
    setNotice(user?.status === 'removed'
      ? t('userRestored')
      : status === 'active' ? t('userApproved') : t('rejectedUser'));
  } catch (error) {
    reportError(error);
  }
}

async function updateUserRole(userId, role) {
  const user = managedUsers.find((item) => item.id === userId);
  if (
    !currentUserIsAdmin()
    || !user
    || userId === profile.uid
    || user.status !== 'active'
    || ![
      'user',
      'admin',
    ].includes(role)
    || user.role === role
  ) {
    return;
  }
  if (role === 'admin' && !userHasVerifiedGoogleIdentity(userId)) {
    setErrorNotice(t('googleVerificationRequired'));
    return;
  }

  try {
    await updateDoc(doc(db, 'users', userId), {
      role,
      updatedAt: serverTimestamp(),
    });
    setNotice(t('userRoleUpdated'));
  } catch (error) {
    reportError(error);
  }
}

async function updateUserLedgerSelectable(userId, ledgerSelectable) {
  const user = managedUsers.find((item) => item.id === userId);
  if (
    !currentUserIsAdmin()
    || !user
    || user.status !== 'active'
    || (user.ledgerSelectable !== false) === ledgerSelectable
  ) {
    return;
  }

  try {
    await updateDoc(doc(db, 'users', userId), {
      ledgerSelectable,
      updatedAt: serverTimestamp(),
    });
    setNotice(t('ledgerSelectableUpdated'));
  } catch (error) {
    reportError(error);
  }
}

async function updateUserDisabled(userId, disabled) {
  const user = managedUsers.find((item) => item.id === userId);
  if (
    !currentUserIsAdmin()
    || !user
    || userId === profile.uid
    || user.status !== 'active'
    || (user.disabled === true) === disabled
  ) {
    return;
  }
  if (disabled && !window.confirm(t('disableUserConfirm', {
    name: userAlias(user),
  }))) {
    return;
  }

  try {
    await updateDoc(doc(db, 'users', userId), {
      disabled,
      updatedAt: serverTimestamp(),
    });
    setNotice(t(disabled ? 'userDisabled' : 'userEnabled'));
  } catch (error) {
    reportError(error);
  }
}

async function removeUser(userId) {
  const user = managedUsers.find((item) => item.id === userId);
  if (!currentUserIsAdmin() || !user || userId === profile.uid) return;
  if (!window.confirm(t('removeUserConfirm', { name: userAlias(user) }))) return;

  try {
    if (user.status === 'active') {
      await updateDoc(doc(db, 'users', userId), {
        currencyRates: {},
        disabled: false,
        email: '',
        photoURL: '',
        role: 'user',
        status: 'removed',
        updatedAt: serverTimestamp(),
      });
    } else {
      await deleteDoc(doc(db, 'users', userId));
    }
    setNotice(t('userRemoved'));
  } catch (error) {
    reportError(error);
  }
}

async function clearRemovedUsers() {
  if (
    !currentUserIsAdmin()
    || isClearingRemovedUsers
    || isClearingLedgerData
    || isBackupBusy
  ) {
    return;
  }

  const removed = removedUsers();
  if (!removed.length) {
    setNotice(t('noRemovedUsersToClear'));
    return;
  }

  const deletable = removed.filter((user) => !isUserReferencedInLedger(user.id));
  const skipped = removed.length - deletable.length;

  if (!deletable.length) {
    setNotice(t('removedUsersStillReferenced', { count: skipped }));
    return;
  }

  const skippedNote = skipped
    ? t('clearRemovedUsersSkippedNote', { skipped })
    : '';
  if (!window.confirm(t('clearRemovedUsersConfirm', {
    count: deletable.length,
    skippedNote,
  }))) {
    return;
  }

  isClearingRemovedUsers = true;
  render();

  try {
    await Promise.all(deletable.map((user) => deleteDoc(doc(db, 'users', user.id))));
    const resultSkippedNote = skipped
      ? t('clearRemovedUsersSkippedNote', { skipped })
      : '';
    setNotice(t('removedUsersCleared', {
      count: deletable.length,
      skippedNote: resultSkippedNote,
    }));
  } catch (error) {
    reportError(error);
  } finally {
    isClearingRemovedUsers = false;
    render();
  }
}

function backupCollectionLabel(collectionName) {
  const labelKey = BACKUP_COLLECTION_LABEL_KEYS[collectionName];
  return labelKey ? t(labelKey) : collectionName;
}

function backupContentsDescription(collections) {
  return t('backupContents', {
    debts: collections.ledgerSplits.length,
    entries: collections.ledger.length,
    images: collections.ledgerImages.length,
  });
}

function backupByteLimitLabel(byteLength) {
  return `${byteLength / (1024 * 1024)} MiB`;
}

function isValidBackupTimestampParts(value) {
  return isPlainObject(value)
    && Number.isSafeInteger(value.seconds)
    && value.seconds >= BACKUP_MIN_TIMESTAMP_SECONDS
    && value.seconds <= BACKUP_MAX_TIMESTAMP_SECONDS
    && Number.isInteger(value.nanoseconds)
    && value.nanoseconds >= 0
    && value.nanoseconds <= 999999999;
}

function serializeBackupTimestamp(value) {
  return isValidBackupTimestampParts(value)
    ? {
      nanoseconds: value.nanoseconds,
      seconds: value.seconds,
    }
    : null;
}

function backupTimestampsEqual(left, right) {
  return isValidBackupTimestampParts(left)
    && isValidBackupTimestampParts(right)
    && left.seconds === right.seconds
    && left.nanoseconds === right.nanoseconds;
}

function serializeBackupDocument(collectionName, snapshot) {
  const data = snapshot.data();
  const record = {
    id: snapshot.id,
  };
  Object.entries(data).forEach(([field, value]) => {
    if (field !== 'id') record[field] = value;
  });
  BACKUP_TIMESTAMP_FIELDS[collectionName].forEach((field) => {
    record[field] = serializeBackupTimestamp(data[field]);
  });
  return record;
}

async function readBackupCollection(collectionName) {
  const snapshot = await getDocsFromServer(collection(db, collectionName));
  return snapshot.docs.map((item) => (
    serializeBackupDocument(collectionName, item)
  ));
}

function downloadBackupBlob(blob) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `nyan-split-ledger-backup-${timestamp}.zip`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportLedgerBackup() {
  if (
    !currentUserIsAdmin()
    || isBackupBusy
    || isClearingLedgerData
  ) {
    return;
  }

  isBackupBusy = true;
  backupStatus = t('backupReading');
  backupStatusType = 'info';
  render();

  try {
    const collectionEntries = await Promise.all(
      BACKUP_COLLECTIONS.map(async (collectionName) => [
        collectionName,
        await readBackupCollection(collectionName),
      ]),
    );
    const collections = Object.fromEntries(collectionEntries);
    validateBackupRecordCount(collections);
    backupStatus = t('backupCreatingArchive');
    render();

    const backupBytes = new TextEncoder().encode(JSON.stringify({
      collections,
      exportedAt: new Date().toISOString(),
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
    }, null, 2));
    if (backupBytes.byteLength > BACKUP_MAX_JSON_BYTES) {
      throw backupValidationError('backupDataTooLarge', {
        max: backupByteLimitLabel(BACKUP_MAX_JSON_BYTES),
      });
    }

    const archive = new JSZip();
    archive.file(BACKUP_ENTRY_NAME, backupBytes);
    const zip = await archive.generateAsync({
      compression: 'DEFLATE',
      compressionOptions: {
        level: 6,
      },
      type: 'blob',
    });
    if (zip.size > BACKUP_MAX_ARCHIVE_BYTES) {
      throw backupValidationError('backupArchiveTooLarge', {
        max: backupByteLimitLabel(BACKUP_MAX_ARCHIVE_BYTES),
      });
    }
    downloadBackupBlob(zip);
    backupStatus = t('backupExportComplete', {
      contents: backupContentsDescription(collections),
    });
  } catch (error) {
    console.error(error);
    backupStatus = error?.name === 'BackupValidationError'
      ? error.message
      : error?.code === 'unavailable'
        ? t('backupOffline')
        : t('backupExportFailed');
    backupStatusType = 'error';
  } finally {
    isBackupBusy = false;
    render();
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function backupValidationError(key, values = {}) {
  const error = new Error(t(key, values));
  error.name = 'BackupValidationError';
  return error;
}

function validateBackupRecordCount(collections) {
  const recordCount = BACKUP_COLLECTIONS.reduce(
    (total, collectionName) => (
      total + (
        Array.isArray(collections[collectionName])
          ? collections[collectionName].length
          : 0
      )
    ),
    0,
  );
  if (recordCount > BACKUP_MAX_RECORDS) {
    throw backupValidationError('backupTooManyRecords', {
      max: BACKUP_MAX_RECORDS,
    });
  }
}

function invalidBackupRecord(collectionName, id, field) {
  throw backupValidationError('backupInvalidRecord', {
    collection: backupCollectionLabel(collectionName),
    field,
    id: id || '?',
  });
}

function validateBackupId(record, collectionName, knownIds) {
  if (!isPlainObject(record)) {
    invalidBackupRecord(collectionName, '?', 'record');
  }

  const id = record.id;
  if (
    typeof id !== 'string'
    || !id
    || id.includes('/')
    || id === '.'
    || id === '..'
    || /^__.*__$/.test(id)
    || new TextEncoder().encode(id).byteLength > BACKUP_MAX_DOCUMENT_ID_BYTES
  ) {
    invalidBackupRecord(collectionName, '?', 'id');
  }
  if (knownIds.has(id)) {
    throw backupValidationError('backupDuplicateRecord', {
      collection: backupCollectionLabel(collectionName),
      id,
    });
  }
  knownIds.add(id);
  return id;
}

function requireBackupString(
  record,
  field,
  collectionName,
  id,
  allowEmpty = false,
) {
  const value = record[field];
  if (
    typeof value !== 'string'
    || (!allowEmpty && !value)
  ) {
    invalidBackupRecord(collectionName, id, field);
  }
  return value;
}

function restoreLegacyBackupTimestamp(milliseconds) {
  let seconds = Math.floor(milliseconds / 1000);
  let nanoseconds = Math.round(
    ((milliseconds - (seconds * 1000)) * 1000000) / 1000,
  ) * 1000;
  if (nanoseconds === 1000000000) {
    seconds += 1;
    nanoseconds = 0;
  }
  return new Timestamp(seconds, nanoseconds);
}

function restoreBackupTimestamp(value, field, collectionName, id) {
  if (isValidBackupTimestampParts(value)) {
    return new Timestamp(value.seconds, value.nanoseconds);
  }
  if (
    typeof value === 'number'
    && Number.isFinite(value)
    && value >= BACKUP_MIN_TIMESTAMP_MILLIS
    && value <= BACKUP_MAX_TIMESTAMP_MILLIS
  ) {
    return restoreLegacyBackupTimestamp(value);
  }
  invalidBackupRecord(collectionName, id, field);
}

function requireBackupUser(userId, validUserIds) {
  if (!validUserIds.has(userId)) {
    throw backupValidationError('backupMissingUser', {
      userId,
    });
  }
}

function backupRecordBytes(record) {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

function normalizeBackupLedgerRecord(
  record,
  knownIds,
  validUserIds,
  allowedCurrencies,
) {
  const collectionName = 'ledger';
  const id = validateBackupId(record, collectionName, knownIds);
  const creditorId = requireBackupString(
    record,
    'creditorId',
    collectionName,
    id,
  );
  const createdBy = requireBackupString(
    record,
    'createdBy',
    collectionName,
    id,
  );
  const rawCurrency = requireBackupString(
    record,
    'currency',
    collectionName,
    id,
  );
  const currency = normalizeCurrency(rawCurrency);
  const note = requireBackupString(
    record,
    'note',
    collectionName,
    id,
    true,
  );
  if (ledgerNoteCharacterCount(note) > MAX_LEDGER_NOTE_LENGTH) {
    invalidBackupRecord(collectionName, id, 'note');
  }
  if (rawCurrency !== currency) {
    invalidBackupRecord(collectionName, id, 'currency');
  }
  if (!allowedCurrencies.has(currency)) {
    throw backupValidationError('backupCurrencyUnavailable', {
      currency,
    });
  }
  requireBackupUser(creditorId, validUserIds);
  requireBackupUser(createdBy, validUserIds);

  return {
    data: {
      creditorId,
      createdAt: restoreBackupTimestamp(
        record.createdAt,
        'createdAt',
        collectionName,
        id,
      ),
      createdBy,
      currency,
      note,
      updatedAt: restoreBackupTimestamp(
        record.updatedAt,
        'updatedAt',
        collectionName,
        id,
      ),
    },
    estimatedBytes: backupRecordBytes(record),
    id,
  };
}

function normalizeBackupSplitRecord(
  record,
  knownIds,
  validUserIds,
  ledgerById,
) {
  const collectionName = 'ledgerSplits';
  const id = validateBackupId(record, collectionName, knownIds);
  const ledgerId = requireBackupString(
    record,
    'ledgerId',
    collectionName,
    id,
  );
  const debtorId = requireBackupString(
    record,
    'debtorId',
    collectionName,
    id,
  );
  const ledger = ledgerById.get(ledgerId);
  if (!ledger || id !== `${ledgerId}_${debtorId}`) {
    invalidBackupRecord(collectionName, id, 'ledgerId');
  }
  if (
    debtorId === ledger.data.creditorId
    || typeof record.amount !== 'number'
    || !Number.isFinite(record.amount)
    || record.amount <= 0
    || !isValidLedgerAmount(record.amount)
    || typeof record.cleared !== 'boolean'
    || !Number.isInteger(record.position)
    || record.position < 0
  ) {
    invalidBackupRecord(collectionName, id, 'values');
  }
  requireBackupUser(debtorId, validUserIds);

  return {
    data: {
      amount: record.amount,
      cleared: record.cleared,
      createdAt: restoreBackupTimestamp(
        record.createdAt,
        'createdAt',
        collectionName,
        id,
      ),
      debtorId,
      ledgerId,
      position: record.position,
      updatedAt: restoreBackupTimestamp(
        record.updatedAt,
        'updatedAt',
        collectionName,
        id,
      ),
    },
    estimatedBytes: backupRecordBytes(record),
    id,
  };
}

function normalizeBackupImageRecord(
  record,
  knownIds,
  validUserIds,
  ledgerById,
) {
  const collectionName = 'ledgerImages';
  const id = validateBackupId(record, collectionName, knownIds);
  const ledgerId = requireBackupString(
    record,
    'ledgerId',
    collectionName,
    id,
  );
  const createdBy = requireBackupString(
    record,
    'createdBy',
    collectionName,
    id,
  );
  const dataUrl = requireBackupString(
    record,
    'dataUrl',
    collectionName,
    id,
  );
  if (!ledgerById.has(ledgerId)) {
    invalidBackupRecord(collectionName, id, 'ledgerId');
  }
  if (
    !isValidLedgerImageDataUrl(dataUrl)
    || dataUrl.length > BACKUP_IMAGE_MAX_CHARACTERS
  ) {
    invalidBackupRecord(collectionName, id, 'dataUrl');
  }
  requireBackupUser(createdBy, validUserIds);

  return {
    data: {
      createdAt: restoreBackupTimestamp(
        record.createdAt,
        'createdAt',
        collectionName,
        id,
      ),
      createdBy,
      dataUrl,
      ledgerId,
    },
    estimatedBytes: backupRecordBytes(record),
    id,
  };
}

function normalizeLedgerBackup(
  payload,
  validUserIds,
  allowedCurrencies,
) {
  if (
    !isPlainObject(payload)
    || payload.format !== BACKUP_FORMAT
    || !BACKUP_SUPPORTED_VERSIONS.includes(payload.version)
    || !isPlainObject(payload.collections)
  ) {
    throw backupValidationError('backupInvalidArchive');
  }

  BACKUP_COLLECTIONS.forEach((collectionName) => {
    if (!Array.isArray(payload.collections[collectionName])) {
      throw backupValidationError('backupMissingCollection', {
        collection: backupCollectionLabel(collectionName),
      });
    }
  });
  validateBackupRecordCount(payload.collections);

  const ledgerIds = new Set();
  const ledger = payload.collections.ledger.map((record) => (
    normalizeBackupLedgerRecord(
      record,
      ledgerIds,
      validUserIds,
      allowedCurrencies,
    )
  ));
  const ledgerById = new Map(
    ledger.map((record) => [
      record.id,
      record,
    ]),
  );
  const splitIds = new Set();
  const ledgerSplits = payload.collections.ledgerSplits.map((record) => (
    normalizeBackupSplitRecord(
      record,
      splitIds,
      validUserIds,
      ledgerById,
    )
  ));
  const splitCounts = new Map();
  ledgerSplits.forEach((record) => {
    const count = (splitCounts.get(record.data.ledgerId) || 0) + 1;
    if (count > MAX_LEDGER_SPLITS) {
      throw backupValidationError('backupTooManyDebts', {
        ledgerId: record.data.ledgerId,
        max: MAX_LEDGER_SPLITS,
      });
    }
    splitCounts.set(record.data.ledgerId, count);
  });
  const imageIds = new Set();
  const ledgerImages = payload.collections.ledgerImages.map((record) => (
    normalizeBackupImageRecord(
      record,
      imageIds,
      validUserIds,
      ledgerById,
    )
  ));

  return {
    ledger,
    ledgerImages,
    ledgerSplits,
  };
}

function backupZipEntrySize(entry, field) {
  const value = entry?._data?.[field];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function backupZipEntryStream(entry) {
  const compressedContent = entry?._data?.compressedContent;
  const compressedByteLength = backupZipEntrySize(entry, 'compressedSize');
  const compressionMagic = entry?._data?.compression?.magic;
  if (
    !(compressedContent instanceof Uint8Array)
    || compressedByteLength === null
    || compressedContent.byteLength !== compressedByteLength
  ) {
    throw backupValidationError('backupInvalidArchive');
  }
  if (
    typeof Blob !== 'function'
    || typeof Blob.prototype.stream !== 'function'
  ) {
    throw backupValidationError('backupDecompressionUnsupported');
  }

  const compressedStream = new Blob([compressedContent]).stream();
  if (compressionMagic === BACKUP_ZIP_STORE_MAGIC) {
    return compressedStream;
  }
  if (compressionMagic !== BACKUP_ZIP_DEFLATE_MAGIC) {
    throw backupValidationError('backupInvalidArchive');
  }
  if (typeof DecompressionStream !== 'function') {
    throw backupValidationError('backupDecompressionUnsupported');
  }

  try {
    return compressedStream.pipeThrough(
      new DecompressionStream('deflate-raw'),
    );
  } catch {
    throw backupValidationError('backupDecompressionUnsupported');
  }
}

async function readBackupZipEntryText(entry, expectedByteLength) {
  const decoder = new TextDecoder('utf-8', {
    fatal: true,
  });
  const textChunks = [];
  const reader = backupZipEntryStream(entry).getReader();
  let byteLength = 0;

  try {
    while (true) {
      const {
        done,
        value,
      } = await reader.read();
      if (done) break;

      byteLength += value.byteLength;
      if (byteLength > BACKUP_MAX_JSON_BYTES) {
        throw backupValidationError('backupDataTooLarge', {
          max: backupByteLimitLabel(BACKUP_MAX_JSON_BYTES),
        });
      }
      try {
        textChunks.push(decoder.decode(value, {
          stream: true,
        }));
      } catch {
        throw backupValidationError('backupInvalidJson');
      }
    }

    if (byteLength !== expectedByteLength) {
      throw backupValidationError('backupInvalidArchive');
    }
    try {
      textChunks.push(decoder.decode());
    } catch {
      throw backupValidationError('backupInvalidJson');
    }
    return textChunks.join('');
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original validation or decompression error.
    }
    if (error?.name === 'BackupValidationError') throw error;
    throw backupValidationError('backupInvalidArchive');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed stream can release its lock during cancellation.
    }
  }
}

async function loadLedgerBackupPayload(file) {
  if (
    !file
    || !Number.isSafeInteger(file.size)
    || file.size <= 0
  ) {
    throw backupValidationError('backupInvalidArchive');
  }
  if (file.size > BACKUP_MAX_ARCHIVE_BYTES) {
    throw backupValidationError('backupArchiveTooLarge', {
      max: backupByteLimitLabel(BACKUP_MAX_ARCHIVE_BYTES),
    });
  }

  let archive;
  try {
    archive = await JSZip.loadAsync(file);
  } catch {
    throw backupValidationError('backupInvalidArchive');
  }
  const backupFile = archive.file(BACKUP_ENTRY_NAME);
  const archiveEntries = Object.values(archive.files);
  if (
    archiveEntries.length !== 1
    || !backupFile
    || Array.isArray(backupFile)
    || backupFile.dir
    || archiveEntries[0].name !== BACKUP_ENTRY_NAME
  ) {
    throw backupValidationError('backupInvalidArchive');
  }

  const compressedByteLength = backupZipEntrySize(
    backupFile,
    'compressedSize',
  );
  const uncompressedByteLength = backupZipEntrySize(
    backupFile,
    'uncompressedSize',
  );
  if (
    compressedByteLength === null
    || uncompressedByteLength === null
    || compressedByteLength > file.size
  ) {
    throw backupValidationError('backupInvalidArchive');
  }
  if (compressedByteLength > BACKUP_MAX_ARCHIVE_BYTES) {
    throw backupValidationError('backupArchiveTooLarge', {
      max: backupByteLimitLabel(BACKUP_MAX_ARCHIVE_BYTES),
    });
  }
  if (uncompressedByteLength > BACKUP_MAX_JSON_BYTES) {
    throw backupValidationError('backupDataTooLarge', {
      max: backupByteLimitLabel(BACKUP_MAX_JSON_BYTES),
    });
  }

  let backupText;
  try {
    backupText = await readBackupZipEntryText(
      backupFile,
      uncompressedByteLength,
    );
  } catch (error) {
    if (error?.name === 'BackupValidationError') throw error;
    throw backupValidationError('backupInvalidArchive');
  }
  try {
    return JSON.parse(backupText);
  } catch {
    throw backupValidationError('backupInvalidJson');
  }
}

async function readBackupImportContext() {
  const [
    ledgerSnapshot,
    settingsSnapshot,
    usersSnapshot,
  ] = await Promise.all([
    getDocsFromServer(collection(db, 'ledger')),
    getDocFromServer(settingsReference),
    getDocsFromServer(collection(db, 'users')),
  ]);
  const settingsData = settingsSnapshot.exists()
    ? settingsSnapshot.data()
    : null;
  const hasCurrencyAllowlist = Boolean(
    settingsData
    && Object.prototype.hasOwnProperty.call(
      settingsData,
      'allowedCurrencies',
    ),
  );
  const configuredCurrencies = hasCurrencyAllowlist
    ? Array.isArray(settingsData.allowedCurrencies)
      ? settingsData.allowedCurrencies.filter((currency) => (
        currency === normalizeCurrency(currency)
      ))
      : []
    : [...DEFAULT_ALLOWED_CURRENCIES];

  return {
    allowedCurrencies: new Set(configuredCurrencies),
    existingLedger: new Map(
      ledgerSnapshot.docs.map((item) => [
        item.id,
        item.data(),
      ]),
    ),
    validUserIds: new Set(
      usersSnapshot.docs
        .filter((item) => LEDGER_USER_STATUSES.includes(item.data().status))
        .map((item) => item.id),
    ),
  };
}

function existingLedgerMatchesBackup(existing, backupRecord) {
  const backup = backupRecord.data;
  return existing.creditorId === backup.creditorId
    && existing.createdBy === backup.createdBy
    && existing.currency === backup.currency
    && existing.note === backup.note
    && backupTimestampsEqual(existing.createdAt, backup.createdAt)
    && backupTimestampsEqual(existing.updatedAt, backup.updatedAt);
}

function validateExistingBackupLedgers(records, existingLedger) {
  records.forEach((record) => {
    const existing = existingLedger.get(record.id);
    if (existing && !existingLedgerMatchesBackup(existing, record)) {
      throw backupValidationError('backupExistingExpenseConflict', {
        id: record.id,
      });
    }
  });
}

function chunkBackupRecords(records) {
  const chunks = [];
  let currentChunk = [];
  let currentBytes = 0;

  records.forEach((record) => {
    if (record.estimatedBytes > BACKUP_MAX_TRANSACTION_BYTES) {
      throw backupValidationError('backupRecordTooLarge', {
        id: record.id,
      });
    }
    const exceedsDocumentLimit = (
      currentChunk.length >= BACKUP_MAX_DOCUMENTS_PER_TRANSACTION
    );
    const exceedsByteLimit = (
      currentChunk.length > 0
      && currentBytes + record.estimatedBytes > BACKUP_MAX_TRANSACTION_BYTES
    );
    if (exceedsDocumentLimit || exceedsByteLimit) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 0;
    }
    currentChunk.push(record);
    currentBytes += record.estimatedBytes;
  });

  if (currentChunk.length) chunks.push(currentChunk);
  return chunks;
}

async function importBackupChunk(collectionName, records) {
  return runTransaction(db, async (transaction) => {
    const references = records.map((record) => (
      doc(db, collectionName, record.id)
    ));
    const snapshots = await Promise.all(
      references.map((reference) => transaction.get(reference)),
    );
    let added = 0;
    snapshots.forEach((snapshot, index) => {
      if (snapshot.exists()) {
        if (
          collectionName === 'ledger'
          && !existingLedgerMatchesBackup(snapshot.data(), records[index])
        ) {
          throw backupValidationError('backupExistingExpenseConflict', {
            id: records[index].id,
          });
        }
        return;
      }
      transaction.set(references[index], records[index].data);
      added += 1;
    });
    return {
      added,
      skipped: records.length - added,
    };
  });
}

async function importLedgerBackup(file) {
  if (
    !currentUserIsAdmin()
    || isBackupBusy
    || isClearingLedgerData
  ) {
    return;
  }

  let addedCount = 0;
  let skippedCount = 0;
  isBackupBusy = true;
  backupStatus = t('backupChecking');
  backupStatusType = 'info';
  render();

  try {
    const payload = await loadLedgerBackupPayload(file);
    const importContext = await readBackupImportContext();
    const collections = normalizeLedgerBackup(
      payload,
      importContext.validUserIds,
      importContext.allowedCurrencies,
    );
    validateExistingBackupLedgers(
      collections.ledger,
      importContext.existingLedger,
    );
    const totalCount = BACKUP_COLLECTIONS.reduce(
      (total, collectionName) => total + collections[collectionName].length,
      0,
    );
    if (!totalCount) {
      backupStatus = t('backupImportEmpty');
      return;
    }

    const contents = backupContentsDescription(collections);
    if (!window.confirm(t('backupImportConfirm', { contents }))) {
      backupStatus = '';
      return;
    }

    const chunksByCollection = Object.fromEntries(
      BACKUP_COLLECTIONS.map((collectionName) => [
        collectionName,
        chunkBackupRecords(collections[collectionName]),
      ]),
    );
    let completedCount = 0;

    for (const collectionName of BACKUP_COLLECTIONS) {
      for (const chunk of chunksByCollection[collectionName]) {
        backupStatus = t('backupImportingProgress', {
          completed: completedCount,
          total: totalCount,
        });
        render();
        const result = await importBackupChunk(collectionName, chunk);
        addedCount += result.added;
        skippedCount += result.skipped;
        completedCount += chunk.length;
      }
    }

    backupStatus = t('backupImportComplete', {
      added: addedCount,
      skipped: skippedCount,
    });
  } catch (error) {
    console.error(error);
    const detail = error.name === 'BackupValidationError'
      ? error.message
      : error.code === 'unavailable'
        ? t('backupOffline')
        : t('backupImportFailed');
    backupStatus = addedCount || skippedCount
      ? t('backupImportFailedAfterProgress', {
        added: addedCount,
        detail,
        skipped: skippedCount,
      })
      : detail;
    backupStatusType = 'error';
  } finally {
    isBackupBusy = false;
    render();
  }
}

async function deleteCollectionDocuments(collectionName) {
  const snapshot = await getDocs(collection(db, collectionName));

  for (let index = 0; index < snapshot.docs.length; index += BATCH_DELETE_LIMIT) {
    const batch = writeBatch(db);
    snapshot.docs
      .slice(index, index + BATCH_DELETE_LIMIT)
      .forEach((item) => batch.delete(item.ref));
    await batch.commit();
  }

  return snapshot.docs.length;
}

async function clearAllLedgerData() {
  if (
    !currentUserIsAdmin()
    || isClearingLedgerData
    || isBackupBusy
  ) {
    return;
  }
  if (!window.confirm(t('clearAllLedgerDataConfirm'))) return;
  if (!window.confirm(t('clearAllLedgerDataFinalConfirm'))) return;

  isClearingLedgerData = true;
  render();

  try {
    const debtsRemoved = await deleteCollectionDocuments('ledgerSplits');
    const imagesRemoved = await deleteCollectionDocuments('ledgerImages');
    const entriesRemoved = await deleteCollectionDocuments('ledger');
    clearAllPendingLedgerEntryImages();
    closeLedgerImageViewer();
    discardLedgerEditDraft();
    setNotice(t('allLedgerDataCleared', {
      debts: debtsRemoved,
      entries: entriesRemoved,
      images: imagesRemoved,
    }));
  } catch (error) {
    reportError(error);
  } finally {
    isClearingLedgerData = false;
    render();
  }
}

async function removeLedgerEntry(entryId) {
  const entry = ledgerEntryById(entryId);
  if (!entry || !canManageEntry(entry)) return;

  try {
    const [splitSnapshot, imageSnapshot] = await Promise.all([
      getDocs(query(
        collection(db, 'ledgerSplits'),
        where('ledgerId', '==', entryId),
      )),
      getDocs(query(
        collection(db, 'ledgerImages'),
        where('ledgerId', '==', entryId),
      )),
    ]);
    if (
      splitSnapshot.docs.length
      + imageSnapshot.docs.length
      + 1
      > BATCH_DELETE_LIMIT
    ) {
      throw new Error('This expense has too many related documents to remove safely.');
    }

    const batch = writeBatch(db);
    splitSnapshot.docs.forEach((item) => batch.delete(item.ref));
    imageSnapshot.docs.forEach((item) => batch.delete(item.ref));
    batch.delete(doc(db, 'ledger', entryId));
    await batch.commit();

    if (selectedLedgerImageEntryId === entryId) {
      closeLedgerImageViewer();
    }
    if (editingLedgerEntryId === entryId) {
      discardLedgerEditDraft();
    }
    revokePendingLedgerEntryImages(ledgerEntryImageKey(entryId));
    setNotice(t('entryRemoved'));
  } catch (error) {
    reportError(error);
  }
}

async function toggleAllLedgerSplitsCleared(entryId) {
  const entry = ledgerEntries.find((item) => item.id === entryId);
  if (!entry || !canManageEntry(entry)) return;
  const splits = ledgerSplitsForEntry(entryId);
  if (!splits.length) return;

  try {
    const cleared = !splits.every((split) => split.cleared);
    const batch = writeBatch(db);
    splits
      .filter((split) => split.cleared !== cleared)
      .forEach((split) => {
        batch.update(doc(db, 'ledgerSplits', split.id), {
          cleared,
          updatedAt: serverTimestamp(),
        });
      });
    await batch.commit();
    setNotice(t(cleared ? 'allDebtsCleared' : 'allDebtsRestored'));
  } catch (error) {
    reportError(error);
  }
}

function stopActiveListeners() {
  stopLedger?.();
  stopLedgerSplits?.();
  stopLedgerImages?.();
  stopUsers?.();
  stopUserAuth?.();
  stopLedger = undefined;
  stopLedgerSplits = undefined;
  stopLedgerImages = undefined;
  stopUsers = undefined;
  stopUserAuth = undefined;
  ledgerEntries = [];
  ledgerSplits = [];
  ledgerEntriesReady = false;
  ledgerSplitsReady = false;
  ledgerImages = new Map();
  discardLedgerEditDraft();
  discardLedgerNewDraft();
  selectableUsers = [];
  knownUsers = [];
  managedUsers = [];
  googleVerifiedUserIds = new Set();
  clearCalculatedSettlements();
}

function watchActiveData() {
  stopActiveListeners();
  const isAdmin = currentUserIsAdmin();
  const usersSource = isAdmin
    ? collection(db, 'users')
    : query(
      collection(db, 'users'),
      where('status', 'in', LEDGER_USER_STATUSES),
    );

  stopUsers = onSnapshot(usersSource, (snapshot) => {
    clearCalculatedSettlements();
    const users = snapshot.docs
      .map((item) => ({
        id: item.id,
        ...item.data(),
      }))
      .sort((left, right) => userAlias(left).localeCompare(userAlias(right)));
    knownUsers = users.filter((user) => LEDGER_USER_STATUSES.includes(user.status));
    selectableUsers = knownUsers.filter(isSelectableLedgerUser);
    managedUsers = isAdmin ? users : [];
    render();
  }, listenerError('Users'));

  if (isAdmin) {
    stopUserAuth = onSnapshot(collection(db, 'userAuth'), (snapshot) => {
      googleVerifiedUserIds = new Set(
        snapshot.docs
          .filter((item) => item.data().provider === GOOGLE_PROVIDER_ID)
          .map((item) => item.id),
      );
      render();
    }, listenerError('Google user verification'));
  }

  stopLedger = onSnapshot(collection(db, 'ledger'), (snapshot) => {
    clearCalculatedSettlements();
    ledgerEntries = snapshot.docs
      .map((item) => ({
        id: item.id,
        ...item.data(),
      }))
      .sort((left, right) => createdAtValue(right) - createdAtValue(left));
    ledgerEntriesReady = true;
    if (
      editingLedgerEntryId
      && !ledgerEntries.some((entry) => entry.id === editingLedgerEntryId)
    ) {
      revokePendingLedgerEntryImages(
        ledgerEntryImageKey(editingLedgerEntryId),
      );
      discardLedgerEditDraft();
    }
    render();
  }, listenerError('Ledger'));

  stopLedgerSplits = onSnapshot(collection(db, 'ledgerSplits'), (snapshot) => {
    clearCalculatedSettlements();
    ledgerSplits = snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data(),
    }));
    ledgerSplitsReady = true;
    render();
  }, listenerError('Ledger debts'));

  stopLedgerImages = onSnapshot(collection(db, 'ledgerImages'), (snapshot) => {
    ledgerImages = new Map();
    snapshot.docs.forEach((item) => {
      const data = item.data();
      const entryId = typeof data.ledgerId === 'string' ? data.ledgerId : '';
      if (!entryId || !isValidLedgerImageDataUrl(data.dataUrl)) return;
      const imageRecord = {
        id: item.id,
        ...data,
      };
      if (!ledgerImages.has(entryId)) ledgerImages.set(entryId, []);
      ledgerImages.get(entryId).push(imageRecord);
    });

    ledgerImages.forEach((images, entryId) => {
      images.sort((left, right) => createdAtValue(left) - createdAtValue(right));
      ledgerImages.set(entryId, images);
    });

    if (selectedLedgerImageEntryId) {
      if (selectedLedgerImageEntryId === NEW_LEDGER_ENTRY_IMAGE_KEY) {
        const viewerImages = ledgerViewerImages(selectedLedgerImageEntryId);
        if (selectedLedgerImageIndex >= viewerImages.length) {
          selectedLedgerImageIndex = Math.max(0, viewerImages.length - 1);
        }
      } else {
        const entry = ledgerEntryById(selectedLedgerImageEntryId);
        const viewerImages = ledgerViewerImages(selectedLedgerImageEntryId);
        if (!entry || (!viewerImages.length && !canManageEntry(entry))) {
          closeLedgerImageViewer();
          pendingLedgerImageFocus = null;
        } else {
          if (pendingLedgerImageFocus?.entryId === selectedLedgerImageEntryId) {
            const focusIndex = viewerImages.findIndex(
              (image) => image.id === pendingLedgerImageFocus.imageId,
            );
            if (focusIndex !== -1) {
              selectedLedgerImageIndex = focusIndex;
              pendingLedgerImageFocus = null;
            }
          } else if (selectedLedgerImageIndex >= viewerImages.length) {
            selectedLedgerImageIndex = Math.max(0, viewerImages.length - 1);
          }
        }
      }
    }
    render();
  }, listenerError('Ledger images'));
}

function clearAllListeners() {
  stopProfile?.();
  stopSettings?.();
  stopProfile = undefined;
  stopSettings = undefined;
  stopActiveListeners();
}

async function fetchVersion() {
  try {
    const response = await fetch('./VERSION');
    if (response.ok) {
      appVersion = (await response.text()).trim();
    }
  } catch (error) {
    console.error('Failed to fetch version:', error);
  }
}

void fetchVersion();

function finishInitialLoading() {
  if (loadingOverlay) loadingOverlay.hidden = true;
}

onAuthStateChanged(auth, (user) => {
  clearAllListeners();
  authUser = user?.isAnonymous ? null : user;
  profile = null;
  activeView = 'ledger';
  ledgerFilter = '';
  notice = '';
  settings = defaultSettings();
  adminCurrencySettings = null;
  initialCurrencyRatesSeeded = false;
  pendingLedgerImageFocus = null;
  clearAllPendingLedgerEntryImages();
  backupStatus = '';
  backupStatusType = 'info';
  isBackupBusy = false;

  if (user?.isAnonymous) {
    render();
    void signOut(auth).catch(reportError);
    return;
  }

  if (!user) {
    render();
    return;
  }

  render();
  void ensureGoogleAuthVerification(user);

  stopSettings = onSnapshot(settingsReference, (snapshot) => {
    clearCalculatedSettlements();
    const nextSettings = snapshot.exists() ? snapshot.data() : {};
    settings = normalizeSettings(nextSettings);
    adminCurrencySettings = null;
    if (isActiveUser(profile)) {
      void seedInitialCurrencyRates();
    }
    render();
  }, listenerError('App settings'));

  stopProfile = onSnapshot(doc(db, 'users', user.uid), (snapshot) => {
    clearCalculatedSettlements();
    if (!snapshot.exists()) {
      profile = {
        uid: user.uid,
        status: 'registration',
      };
      stopActiveListeners();
      renderRegistration();
      return;
    }

    profile = {
      uid: user.uid,
      ...snapshot.data(),
    };
    if (isActiveUser(profile)) {
      watchActiveData();
      void seedInitialCurrencyRates();
    } else stopActiveListeners();
    render();
  }, listenerError('Profile'));
});
