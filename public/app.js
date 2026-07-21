import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signOut,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
  collection,
  deleteDoc,
  doc,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { getLocale, t, toggleLocale } from './i18n.js';
import QRCode from './vendor/qrcode.mjs';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const google = new GoogleAuthProvider();
const root = document.querySelector('#root');
const settingsReference = doc(db, 'settings', 'app');

const DEFAULT_CURRENCY = 'TWD';
const EXCHANGE_RATE_URL = 'https://open.er-api.com/v6/latest/';
const SETTLEMENT_EPSILON = 0.005;
const IMAGE_MAX_DIMENSION = 1600;
const IMAGE_MIN_DIMENSION = 480;
const IMAGE_MAX_BYTES = 500 * 1024;
const JPEG_QUALITIES = [
  .78,
  .68,
  .58,
  .48,
];
const DEFAULT_ALLOWED_CURRENCIES = [
  'TWD',
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
let ledgerImages = new Map();
let activeUsers = [];
let notice = '';
let activeView = 'ledger';
let activeAdminTab = 'users';
let pendingResultCurrency = '';
let pendingCurrencyRateDraft = null;
let selectedLedgerImageEntryId = '';
let selectedLedgerImageIndex = 0;
let editingLedgerEntryId = '';
let pendingLedgerImageFocus = null;
let seedingCurrencyRates = false;
let initialCurrencyRatesSeeded = false;

let stopProfile;
let stopSettings;
let stopLedger;
let stopLedgerImages;
let stopUsers;
let deferredInstallPrompt = null;
let appInstalled = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

const usdRates = new Map([['USD', 1]]);
const rateRequests = new Map();

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (authUser && profile?.status === 'active' && activeView === 'share') render();
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

function defaultAlias() {
  if (authUser?.isAnonymous) return t('anonymousUser');
  return cleanAlias(authUser?.displayName)
    || authUser?.email?.split('@')[0]
    || t('newUser');
}

function userAlias(user) {
  return user?.alias || user?.name || user?.email?.split('@')[0] || t('unknownUser');
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
  if (currency !== resultCurrency && !usdRates.has(currency)) {
    void fetchUsdRate(currency).then(render).catch(() => undefined);
  }
  if (!usdRates.has(resultCurrency)) {
    void fetchUsdRate(resultCurrency).then(render).catch(() => undefined);
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

function amountInResultCurrency(entry, resultCurrency) {
  const amount = Number(entry.amount);
  const sourceCurrency = normalizeCurrency(entry.currency) || DEFAULT_CURRENCY;
  const rate = resultRate(sourceCurrency, resultCurrency);
  if (!Number.isFinite(amount) || amount <= 0 || !isPositiveRate(rate)) return null;
  return amount * rate;
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

function setNotice(message = '') {
  notice = message;
  render();
}

function reportError(error) {
  console.error(error);
  setNotice(t('operationFailed'));
}

function listenerError(context) {
  return (error) => reportError(new Error(`${context}: ${error.message}`));
}

function brand() {
  return `<div class="brand">
    <p class="brand-mark" aria-hidden="true">🌈🐱</p>
    <div>
      <h1>NyanSplit</h1>
      <p>${escapeHtml(t('tagline'))}</p>
    </div>
  </div>`;
}

function preferenceControls() {
  const themeLabel = document.documentElement.dataset.theme === 'dark' ? t('light') : t('dark');
  return `<div class="preference-controls" aria-label="${escapeHtml(t('displayPreferences'))}">
    <button class="text-button preference-button" type="button" data-action="locale">${escapeHtml(t('language'))}</button>
    <button class="text-button preference-button" type="button" data-action="theme">${escapeHtml(themeLabel)}</button>
  </div>`;
}

function authFrame(content) {
  return `<main class="auth-shell">
    <section class="auth-card">
      ${preferenceControls()}
      ${brand()}
      ${notice ? `<p class="notice" role="alert">${escapeHtml(notice)}</p>` : ''}
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
    <p class="eyebrow">NyanSplit</p>
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
}

function renderPending() {
  const rejected = profile.status === 'rejected';
  root.innerHTML = authFrame(`
    <p class="eyebrow">${escapeHtml(userAlias(profile))}</p>
    <h2>${escapeHtml(rejected ? t('rejected') : t('pending'))}</h2>
    <p class="muted">${escapeHtml(rejected ? t('rejectedText') : t('pendingText'))}</p>
    <button class="text-button" type="button" data-action="signout">${escapeHtml(t('signOut'))}</button>
  `);
  bind();
}

function calculateBalances() {
  const resultCurrency = profileCurrency();
  const balances = new Map();
  ledgerEntries.forEach((entry) => {
    if (entry.cleared) return;
    const amount = amountInResultCurrency(entry, resultCurrency);
    const debtorId = entry.debtorId || entry.owedBy;
    const creditorId = entry.creditorId || entry.paidBy;
    if (!Number.isFinite(amount) || amount <= 0 || !debtorId || !creditorId) return;
    balances.set(creditorId, (balances.get(creditorId) || 0) + amount);
    balances.set(debtorId, (balances.get(debtorId) || 0) - amount);
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
      return rate;
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
    || profile.status !== 'active'
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
  return activeUsers
    .filter((user) => user.id !== excludedUserId)
    .map((user) => (
      `<option value="${escapeHtml(user.id)}"${user.id === selectedUserId ? ' selected' : ''}>${escapeHtml(userAlias(user))}</option>`
    ))
    .join('');
}

function updateCreditorOptions(event) {
  const debtorId = event.currentTarget.value;
  const creditorSelect = event.currentTarget.form?.querySelector('[name="creditorId"]');
  if (!creditorSelect) return;

  const currentCreditorId = creditorSelect.value;
  const fallbackCreditorId = activeUsers.find((user) => user.id !== debtorId)?.id || '';
  const selectedCreditorId = currentCreditorId !== debtorId
    ? currentCreditorId
    : fallbackCreditorId;
  creditorSelect.innerHTML = accountOptions(selectedCreditorId, debtorId);
}

function canManageEntry(entry) {
  return entry.createdBy === profile.uid || profile.role === 'admin';
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

function renderLedgerImageButton(entry) {
  const images = ledgerImagesForEntry(entry.id);
  const canManage = canManageEntry(entry);
  if (!images.length && !canManage) return '—';

  const label = images.length
    ? t('viewImageCount', { count: images.length })
    : t('addImage');
  const countLabel = images.length ? ` (${images.length})` : '';

  return `<button class="ledger-image-button secondary-button" type="button" data-view-ledger-image="${escapeHtml(entry.id)}" aria-label="${escapeHtml(label)}">${escapeHtml(t('image'))}${escapeHtml(countLabel)}</button>`;
}

function renderLedgerImageViewer() {
  const entry = ledgerEntryById(selectedLedgerImageEntryId);
  if (!entry) {
    selectedLedgerImageEntryId = '';
    selectedLedgerImageIndex = 0;
    return renderLedger();
  }

  const images = ledgerImagesForEntry(entry.id);
  const canManage = canManageEntry(entry);
  const maxIndex = Math.max(0, images.length - 1);
  const currentIndex = images.length
    ? Math.min(Math.max(selectedLedgerImageIndex, 0), maxIndex)
    : 0;
  selectedLedgerImageIndex = currentIndex;
  const currentImage = images[currentIndex] || null;
  const debtor = userAlias(activeUsers.find((user) => user.id === (entry.debtorId || entry.owedBy)));
  const creditor = userAlias(activeUsers.find((user) => user.id === (entry.creditorId || entry.paidBy)));

  return `<section class="page-content narrow-content">
    <div class="page-heading ledger-image-heading">
      <div>
        <p class="eyebrow">${escapeHtml(t('ledger'))}</p>
        <h2>${escapeHtml(t('image'))}</h2>
        <p class="muted">${escapeHtml(`${debtor} ${t('debtConnector')} ${creditor}`)}</p>
      </div>
      <button class="secondary-button" type="button" data-action="back-to-ledger">${escapeHtml(t('backToLedger'))}</button>
    </div>
    <section class="accounting-card ledger-image-view">
      ${currentImage
    ? `<div class="ledger-image-stage"><img src="${escapeHtml(currentImage.dataUrl)}" alt="${escapeHtml(t('ledgerImage'))}" /></div>`
    : `<p class="muted ledger-image-empty">${escapeHtml(t('noImagesYet'))}</p>`}
      ${images.length > 0 ? `<div class="ledger-image-nav">
        <button class="secondary-button" type="button" data-action="ledger-image-prev"${currentIndex === 0 ? ' disabled' : ''}>${escapeHtml(t('previousImage'))}</button>
        <span class="ledger-image-count">${escapeHtml(t('imagePosition', { current: currentIndex + 1, total: Math.max(images.length, 1) }))}</span>
        <button class="secondary-button" type="button" data-action="ledger-image-next"${currentIndex >= maxIndex ? ' disabled' : ''}>${escapeHtml(t('nextImage'))}</button>
      </div>` : ''}
      ${canManage ? `<div class="ledger-image-actions">
        <div class="ledger-image-picker">
          <label class="file-picker">
            <input class="sr-only" id="ledger-image-upload" name="imageUpload" type="file" accept="image/*" />
            <span>${escapeHtml(t('uploadImage'))}</span>
          </label>
          <label class="file-picker">
            <input class="sr-only" id="ledger-image-camera" name="imageCamera" type="file" accept="image/*" capture="environment" />
            <span>${escapeHtml(t('takePhoto'))}</span>
          </label>
        </div>
        ${currentImage ? `<button class="secondary-button danger-text" type="button" data-delete-ledger-image="${escapeHtml(currentImage.id)}">${escapeHtml(t('deleteImage'))}</button>` : ''}
      </div>` : ''}
    </section>
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
      const hasDraftRate = rateDraft
        && Object.prototype.hasOwnProperty.call(rateDraft, currency);
      const savedRate = hasDraftRate
        ? rateDraft[currency]
        : personalRates[currency] || '';
      const placeholder = publicRate
        ? formatRate(publicRate)
        : t('publicRateLoading');
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
  const settlements = calculateSettlementPlan();
  const balanceRows = activeUsers.map((user) => {
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
  const settlementRows = settlements.map((settlement) => {
    const debtor = userAlias(activeUsers.find((user) => user.id === settlement.debtorId));
    const creditor = userAlias(activeUsers.find((user) => user.id === settlement.creditorId));
    return `<div class="settlement-row">
      <span class="settlement-transfer" aria-label="${escapeHtml(t('settlementTransfer', { debtor, creditor }))}">
        <span class="settlement-name" title="${escapeHtml(debtor)}">${escapeHtml(debtor)}</span>
        <span class="settlement-arrow" aria-hidden="true">→</span>
        <span class="settlement-name" title="${escapeHtml(creditor)}">${escapeHtml(creditor)}</span>
      </span>
      <strong class="credit">${escapeHtml(formatMoney(settlement.amount, currency))}</strong>
    </div>`;
  }).join('');

  return `<section class="accounting-card settlement-card">
    <div class="card-heading">
      <div>
        <h3>${escapeHtml(t('settlementSummary'))}</h3>
        <p>${escapeHtml(t('settlementSummaryHelp', { currency }))}</p>
      </div>
    </div>
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
        <div class="settlement-list">${settlementRows || `<p class="muted">${escapeHtml(t('settlementNoTransfers'))}</p>`}</div>
      </section>
    </div>
  </section>`;
}

function renderLedgerEntryEdit(entry) {
  const debtorId = entry.debtorId || entry.owedBy;
  const creditorId = entry.creditorId || entry.paidBy;
  const currency = entry.currency || DEFAULT_CURRENCY;

  return `<tr class="ledger-row-editing">
    <td colspan="8">
      <form id="ledger-edit-form" class="ledger-form ledger-edit-form">
        <label class="field ledger-person-field"><span class="sr-only">${escapeHtml(t('debtor'))}</span><select name="debtorId" aria-label="${escapeHtml(t('debtor'))}">${accountOptions(debtorId)}</select></label>
        <span class="debt-connector" aria-hidden="true">${escapeHtml(t('debtConnector'))}</span>
        <label class="field ledger-person-field"><span class="sr-only">${escapeHtml(t('creditor'))}</span><select name="creditorId" aria-label="${escapeHtml(t('creditor'))}">${accountOptions(creditorId, debtorId)}</select></label>
        <label class="field ledger-amount-field"><span>${escapeHtml(t('amount'))}</span><input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="${escapeHtml(String(entry.amount ?? ''))}" required /></label>
        <label class="field ledger-currency-field"><span>${escapeHtml(t('currency'))}</span><select name="currency">${renderCurrencyOptions(currency)}</select></label>
        <label class="field field-wide ledger-note-field"><span>${escapeHtml(t('note'))}</span><input name="note" maxlength="160" value="${escapeHtml(entry.note || '')}" placeholder="${escapeHtml(t('notePlaceholder'))}" /></label>
        <div class="ledger-edit-actions">
          <button type="submit">${escapeHtml(t('saveChanges'))}</button>
          <button class="secondary-button" type="button" data-cancel-edit-entry="${escapeHtml(entry.id)}">${escapeHtml(t('cancel'))}</button>
        </div>
      </form>
    </td>
  </tr>`;
}

function renderLedgerRows() {
  if (!ledgerEntries.length) {
    return `<tr><td class="empty-cell" colspan="8">${escapeHtml(t('noEntries'))}</td></tr>`;
  }

  return ledgerEntries.flatMap((entry) => {
    if (editingLedgerEntryId === entry.id) {
      return [renderLedgerEntryEdit(entry)];
    }

    const debtorId = entry.debtorId || entry.owedBy;
    const creditorId = entry.creditorId || entry.paidBy;
    const debtor = userAlias(activeUsers.find((user) => user.id === debtorId));
    const creditor = userAlias(activeUsers.find((user) => user.id === creditorId));
    const cleared = Boolean(entry.cleared);
    const actions = canManageEntry(entry)
      ? `<div class="entry-action-list">
        <button class="clear-entry-button" type="button" data-edit-entry="${escapeHtml(entry.id)}">${escapeHtml(t('editEntry'))}</button>
        <button class="clear-entry-button" type="button" data-toggle-clear-entry="${escapeHtml(entry.id)}">${escapeHtml(t(cleared ? 'restoreEntry' : 'clearEntry'))}</button>
        <button class="clear-entry-button danger" type="button" data-delete-entry="${escapeHtml(entry.id)}">${escapeHtml(t('deleteEntry'))}</button>
      </div>`
      : '—';
    return [`<tr class="${cleared ? 'ledger-row-cleared' : ''}">
    <td class="ledger-mobile-summary">${escapeHtml(debtor)} <span class="settlement-arrow">→</span> ${escapeHtml(creditor)}</td>
    <td class="ledger-user-cell" title="${escapeHtml(debtor)}">${escapeHtml(debtor)}</td>
    <td class="debt-table-connector">${escapeHtml(t('debtConnector'))}</td>
    <td class="ledger-user-cell" title="${escapeHtml(creditor)}">${escapeHtml(creditor)}</td>
    <td>${escapeHtml(formatMoney(entry.amount, entry.currency || DEFAULT_CURRENCY))}</td>
    <td>${escapeHtml(entry.note || '—')}</td>
    <td class="ledger-image-cell">${renderLedgerImageButton(entry)}</td>
    <td class="entry-actions">${actions}</td>
  </tr>`];
  }).join('');
}

function renderLedger() {
  const myBalance = calculateBalances().get(profile.uid) || 0;
  const entryCurrency = settings.defaultCurrency;
  const canAddEntry = activeUsers.length > 1;
  const creditorDefault = activeUsers.find((user) => user.id !== profile.uid)?.id || '';

  return `<section class="page-content">
    <div class="page-heading">
      <div>
        <p class="eyebrow">${escapeHtml(t('ledger'))}</p>
        <h2>${escapeHtml(t('accounting'))}</h2>
        <p class="muted">${escapeHtml(t('ledgerHelp'))}</p>
      </div>
    </div>

    <section class="accounting-card ledger-card">
      <div class="card-heading"><div><h3>${escapeHtml(t('ledger'))}</h3><p>${escapeHtml(t('ledgerHelp'))}</p></div></div>
      <section class="ledger-entry-section">
        <div class="card-heading">
          <div>
            <h3>${escapeHtml(t('newEntry'))}</h3>
            <p>${escapeHtml(t('newEntryCurrency', { currency: entryCurrency }))}</p>
          </div>
        </div>
        ${canAddEntry ? `<form id="ledger-form" class="ledger-form">
          <label class="field ledger-person-field"><span class="sr-only">${escapeHtml(t('debtor'))}</span><select name="debtorId" aria-label="${escapeHtml(t('debtor'))}">${accountOptions(profile.uid)}</select></label>
          <span class="debt-connector" aria-hidden="true">${escapeHtml(t('debtConnector'))}</span>
          <label class="field ledger-person-field"><span class="sr-only">${escapeHtml(t('creditor'))}</span><select name="creditorId" aria-label="${escapeHtml(t('creditor'))}">${accountOptions(creditorDefault, profile.uid)}</select></label>
          <label class="field ledger-amount-field"><span>${escapeHtml(t('amount'))}</span><input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" required /></label>
          <label class="field ledger-currency-field"><span>${escapeHtml(t('currency'))}</span><select name="currency">${renderCurrencyOptions(entryCurrency)}</select></label>
          <label class="field field-wide ledger-note-field"><span>${escapeHtml(t('note'))}</span><input name="note" maxlength="160" placeholder="${escapeHtml(t('notePlaceholder'))}" /></label>
          <button type="submit">${escapeHtml(t('saveEntry'))}</button>
        </form>` : `<p class="muted">${escapeHtml(t('needTwoUsers'))}</p>`}
      </section>
      <div class="table-wrap">
        <table class="ledger-table">
          <thead><tr><th class="ledger-mobile-summary-column"></th><th class="ledger-user-column">${escapeHtml(t('debtor'))}</th><th class="ledger-debt-column" aria-label="${escapeHtml(t('debtConnector'))}"></th><th class="ledger-user-column">${escapeHtml(t('creditor'))}</th><th class="ledger-amount-column">${escapeHtml(t('amount'))}</th><th>${escapeHtml(t('note'))}</th><th class="ledger-image-column">${escapeHtml(t('image'))}</th><th>${escapeHtml(t('action'))}</th></tr></thead>
          <tbody>${renderLedgerRows()}</tbody>
        </table>
      </div>
    </section>

    ${renderSettlementSummary(myBalance)}
    ${renderCurrencyConversionSettings()}
  </section>`;
}

function renderAccount() {
  return `<section class="page-content narrow-content">
    <div class="page-heading"><div><p class="eyebrow">NyanSplit</p><h2>${escapeHtml(t('account'))}</h2></div></div>
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
    <div class="page-heading"><div><p class="eyebrow">NyanSplit</p><h2>${escapeHtml(t('shareInstall'))}</h2></div></div>
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

function statusBadge(status) {
  const statusKey = {
    active: 'statusActive',
    pending: 'statusPending',
    rejected: 'statusRejected',
  }[status] || 'statusPending';
  return `<span class="status-badge status-${escapeHtml(status)}">${escapeHtml(t(statusKey))}</span>`;
}

function renderUserRows() {
  return activeUsers.map((user) => `<tr>
    <td>
      <div style="display: flex; align-items: center; gap: .75rem;">
        ${renderUserAvatar(user)}
        <div style="min-width: 0; overflow: hidden; text-overflow: ellipsis;">
          <strong>${escapeHtml(userAlias(user))}</strong><br />
          <span class="muted">${escapeHtml(user.email || 'N/A')}</span>
        </div>
      </div>
    </td>
    <td>${statusBadge(user.status || 'pending')}</td>
    <td class="user-actions">${user.status === 'pending' ? `<button type="button" data-user-status="active" data-user-id="${escapeHtml(user.id)}">${escapeHtml(t('approve'))}</button><button class="secondary-button danger-text" type="button" data-user-status="rejected" data-user-id="${escapeHtml(user.id)}">${escapeHtml(t('reject'))}</button>` : user.status === 'rejected' ? `<button type="button" data-user-status="active" data-user-id="${escapeHtml(user.id)}">${escapeHtml(t('approve'))}</button>` : ''}${user.id !== profile.uid ? `<button class="secondary-button danger-text" type="button" data-remove-user="${escapeHtml(user.id)}">${escapeHtml(t('removeUser'))}</button>` : user.status === 'active' ? '<span class="muted">—</span>' : ''}</td>
  </tr>`).join('');
}

function renderAdmin() {
  const adminSettings = currentAdminCurrencySettings();
  const isCurrencyTab = activeAdminTab === 'currencies';
  const content = isCurrencyTab
    ? renderAdminCurrencySettings(adminSettings)
    : renderAdminUsers();

  return `<section class="page-content narrow-content">
    <div class="page-heading"><div><p class="eyebrow">${escapeHtml(t('settings'))}</p><h2>${escapeHtml(t('settings'))}</h2></div></div>
    <div class="admin-tabs" role="tablist" aria-label="${escapeHtml(t('settings'))}">
      <button class="admin-tab${isCurrencyTab ? '' : ' chosen'}" id="admin-tab-users" type="button" role="tab" aria-controls="admin-panel-users" aria-selected="${String(!isCurrencyTab)}" data-admin-tab="users">${escapeHtml(t('users'))}</button>
      <button class="admin-tab${isCurrencyTab ? ' chosen' : ''}" id="admin-tab-currencies" type="button" role="tab" aria-controls="admin-panel-currencies" aria-selected="${String(isCurrencyTab)}" data-admin-tab="currencies">${escapeHtml(t('allowedCurrencies'))}</button>
    </div>
    ${content}
  </section>`;
}

function renderAdminCurrencySettings(adminSettings) {
  return `<section class="accounting-card" id="admin-panel-currencies" role="tabpanel" aria-labelledby="admin-tab-currencies">
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

function renderAdminUsers() {
  return `<section class="accounting-card" id="admin-panel-users" role="tabpanel" aria-labelledby="admin-tab-users">
      <div class="card-heading"><div><h3>${escapeHtml(t('users'))}</h3><p>${escapeHtml(t('usersHelp'))}</p></div></div>
      <form id="add-user-form" class="inline-form" style="margin-bottom: 1rem;">
        <label class="field"><span>${escapeHtml(t('alias'))}</span><input name="alias" maxlength="40" placeholder="${escapeHtml(t('alias'))}" required autocomplete="off" /></label>
        <button type="submit" class="secondary-button">${escapeHtml(t('addUser'))}</button>
      </form>
      <div class="table-wrap"><table class="admin-users-table">
        <thead><tr><th>${escapeHtml(t('user'))}</th><th>${escapeHtml(t('status'))}</th><th>${escapeHtml(t('actions'))}</th></tr></thead>
        <tbody>${renderUserRows()}</tbody>
      </table></div>
    </section>`;
}

function renderApplication() {
  const content = selectedLedgerImageEntryId
    ? renderLedgerImageViewer()
    : activeView === 'account'
      ? renderAccount()
      : activeView === 'share'
        ? renderShare()
        : activeView === 'admin' && profile.role === 'admin'
          ? renderAdmin()
          : renderLedger();

  root.innerHTML = `<main class="app-shell">
    <aside class="side-panel">
      ${brand()}
      <section class="profile-summary${activeView === 'account' ? ' chosen' : ''}" role="button" tabindex="0" data-view="account" aria-label="${escapeHtml(t('account'))}">
        ${renderUserAvatar(profile)}
        <div><strong>${escapeHtml(userAlias(profile))}</strong><span>${escapeHtml(profileCurrency())}</span></div>
      </section>
    </aside>
    <nav class="app-nav" aria-label="${escapeHtml(t('applicationNavigation'))}">
      ${navigationItem('ledger', '🧮', t('accounting'))}
      ${navigationItem('share', '🔗', t('shareInstall'))}
      ${profile.role === 'admin' ? navigationItem('admin', '⚙️', t('settings')) : ''}
    </nav>
    <section class="content-panel">
      ${notice ? `<p class="notice" role="alert">${escapeHtml(notice)}</p>` : ''}
      ${content}
    </section>
  </main>`;
  bind();
  if (activeView === 'share') void renderShareQr();
}

function render() {
  if (!authUser) {
    root.innerHTML = authFrame(`
      <p class="eyebrow">NyanSplit</p>
      <h2>${escapeHtml(t('loginHeading'))}</h2>
      <p class="muted">${escapeHtml(t('loginHelp'))}</p>
      <button type="button" data-action="login">${escapeHtml(t('login'))}</button>
      <button class="secondary-button" type="button" data-action="anonymous-login">${escapeHtml(t('anonymousLogin'))}</button>
      <p class="muted">${escapeHtml(t('anonymousLoginHelp'))}</p>
    `);
    bind();
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

  if (profile.status !== 'active') {
    renderPending();
    return;
  }

  renderApplication();
}

function bind() {
  document.querySelectorAll('[data-action="login"]').forEach((button) => {
    button.onclick = () => signInWithPopup(auth, google).catch(reportError);
  });
  document.querySelectorAll('[data-action="anonymous-login"]').forEach((button) => {
    button.onclick = () => signInAnonymously(auth).catch(reportError);
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
      activeView = button.dataset.view;
      selectedLedgerImageEntryId = '';
      selectedLedgerImageIndex = 0;
      editingLedgerEntryId = '';
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
  document.querySelectorAll('[data-admin-tab]').forEach((button) => {
    button.onclick = () => {
      activeAdminTab = button.dataset.adminTab;
      notice = '';
      render();
    };
  });
  document.querySelector('#registration-form')?.addEventListener('submit', completeRegistration);
  document.querySelector('#account-form')?.addEventListener('submit', saveAccount);
  document.querySelector('#add-user-form')?.addEventListener('submit', addAdminUser);
  const ledgerForm = document.querySelector('#ledger-form');
  ledgerForm?.addEventListener('submit', addLedgerEntry);
  ledgerForm?.elements.debtorId?.addEventListener('change', updateCreditorOptions);
  const ledgerEditForm = document.querySelector('#ledger-edit-form');
  ledgerEditForm?.addEventListener('submit', updateLedgerEntry);
  ledgerEditForm?.elements.debtorId?.addEventListener('change', updateCreditorOptions);
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
  document.querySelectorAll('[data-remove-user]').forEach((button) => {
    button.onclick = () => removeUser(button.dataset.removeUser);
  });
  document.querySelectorAll('[data-edit-entry]').forEach((button) => {
    button.onclick = () => {
      editingLedgerEntryId = button.dataset.editEntry;
      selectedLedgerImageEntryId = '';
      selectedLedgerImageIndex = 0;
      notice = '';
      render();
    };
  });
  document.querySelectorAll('[data-cancel-edit-entry]').forEach((button) => {
    button.onclick = () => {
      editingLedgerEntryId = '';
      render();
    };
  });
  document.querySelectorAll('[data-delete-entry]').forEach((button) => {
    button.onclick = () => {
      if (confirm(t('deleteEntryConfirm'))) {
        removeLedgerEntry(button.dataset.deleteEntry);
      }
    };
  });
  document.querySelectorAll('[data-toggle-clear-entry]').forEach((button) => {
    button.onclick = () => toggleLedgerEntryCleared(button.dataset.toggleClearEntry);
  });
  document.querySelectorAll('[data-view-ledger-image]').forEach((button) => {
    button.onclick = () => {
      selectedLedgerImageEntryId = button.dataset.viewLedgerImage;
      selectedLedgerImageIndex = 0;
      editingLedgerEntryId = '';
      render();
    };
  });
  document.querySelector('.ledger-image-view')?.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="ledger-image-prev"]:not([disabled])')) {
      if (selectedLedgerImageIndex > 0) {
        selectedLedgerImageIndex -= 1;
        render();
      }
      return;
    }
    if (event.target.closest('[data-action="ledger-image-next"]:not([disabled])')) {
      const images = ledgerImagesForEntry(selectedLedgerImageEntryId);
      if (selectedLedgerImageIndex < images.length - 1) {
        selectedLedgerImageIndex += 1;
        render();
      }
    }
  });
  document.querySelector('#ledger-image-upload')?.addEventListener('change', (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) void addLedgerImage(selectedLedgerImageEntryId, file);
  });
  document.querySelector('#ledger-image-camera')?.addEventListener('change', (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) void addLedgerImage(selectedLedgerImageEntryId, file);
  });
  document.querySelectorAll('[data-delete-ledger-image]').forEach((button) => {
    button.onclick = () => removeLedgerImage(button.dataset.deleteLedgerImage);
  });
  document.querySelector('[data-action="back-to-ledger"]')?.addEventListener('click', () => {
    selectedLedgerImageEntryId = '';
    selectedLedgerImageIndex = 0;
    activeView = 'ledger';
    render();
  });
  document.querySelector('[data-action="copy-share-url"]')?.addEventListener('click', copyShareUrl);
  document.querySelector('[data-action="install-app"]')?.addEventListener('click', installApp);
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
    setNotice(t('qrFailed'));
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
      setNotice(t('copyFailed'));
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

async function completeRegistration(event) {
  event.preventDefault();
  try {
    const alias = cleanAlias(new FormData(event.currentTarget).get('alias')) || defaultAlias();
    await setDoc(doc(db, 'users', authUser.uid), {
      alias,
      email: authUser.email || '',
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
      setNotice(t('aliasRequired'));
      return;
    }
    await setDoc(doc(collection(db, 'users')), {
      alias,
      email: '',
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
      setNotice(t('aliasRequired'));
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
      setNotice(t('currencyNotAllowed'));
      return;
    }

    const currencyRates = {};
    for (const currency of settings.allowedCurrencies) {
      if (currency === resultCurrency) continue;
      const rawRate = String(form.get(`currencyRate-${currency}`) || '').trim();
      if (!rawRate) continue;

      const rate = Number(rawRate);
      if (!isPositiveRate(rate)) {
        setNotice(t('currencyRateInvalid', { currency }));
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
    const form = new FormData(formElement);
    const debtorId = form.get('debtorId');
    const creditorId = form.get('creditorId');
    const amount = Number(form.get('amount'));
    const currency = normalizeCurrency(form.get('currency'));
    const note = String(form.get('note') || '').trim().slice(0, 160);
    if (!debtorId || !creditorId || debtorId === creditorId) {
      setNotice(t('differentPeople'));
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setNotice(t('amountPositive'));
      return;
    }
    if (!isAllowedCurrency(currency)) {
      setNotice(t('currencyNotAllowed'));
      return;
    }

    const ledgerReference = doc(collection(db, 'ledger'));
    await setDoc(ledgerReference, {
      amount,
      cleared: false,
      creditorId,
      createdAt: serverTimestamp(),
      createdBy: profile.uid,
      currency,
      debtorId,
      note,
    });
    formElement.reset();
    setNotice(t('entryAdded'));
  } catch (error) {
    reportError(error);
  }
}

async function updateLedgerEntry(event) {
  event.preventDefault();
  try {
    const entry = ledgerEntryById(editingLedgerEntryId);
    if (!entry || !canManageEntry(entry)) return;

    const form = new FormData(event.currentTarget);
    const debtorId = form.get('debtorId');
    const creditorId = form.get('creditorId');
    const amount = Number(form.get('amount'));
    const currency = normalizeCurrency(form.get('currency'));
    const note = String(form.get('note') || '').trim().slice(0, 160);
    if (!debtorId || !creditorId || debtorId === creditorId) {
      setNotice(t('differentPeople'));
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setNotice(t('amountPositive'));
      return;
    }
    if (!isAllowedCurrency(currency)) {
      setNotice(t('currencyNotAllowed'));
      return;
    }

    await updateDoc(doc(db, 'ledger', entry.id), {
      amount,
      creditorId,
      currency,
      debtorId,
      note,
    });
    editingLedgerEntryId = '';
    setNotice(t('entryUpdated'));
  } catch (error) {
    reportError(error);
  }
}

async function addLedgerImage(entryId, file) {
  const entry = ledgerEntryById(entryId);
  if (!entry || !canManageEntry(entry)) return;
  if (!file.type.startsWith('image/')) {
    setNotice(t('imageUnsupported'));
    return;
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
  } catch (error) {
    console.warn('Could not add the ledger image.', error);
    setNotice(error.message === 'The selected image is too large.'
      ? t('imageTooLarge')
      : t('operationFailed'));
  }
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
    setNotice(t('currencyCodeInvalid'));
    return;
  }

  const adminSettings = currentAdminCurrencySettings();
  if (adminSettings.allowedCurrencies.includes(currency)) {
    setNotice(t('currencyAlreadyAllowed', { currency }));
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
    setNotice(t('cannotRemoveDefaultCurrency', { currency }));
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
      setNotice(t('currencyNotAllowed'));
      return;
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
    await updateDoc(doc(db, 'users', userId), {
      status,
      updatedAt: serverTimestamp(),
    });
    setNotice(status === 'active' ? t('userApproved') : t('rejectedUser'));
  } catch (error) {
    reportError(error);
  }
}

async function removeUser(userId) {
  const user = activeUsers.find((item) => item.id === userId);
  if (!user || userId === profile.uid) return;
  if (!window.confirm(t('removeUserConfirm', { name: userAlias(user) }))) return;

  try {
    await deleteDoc(doc(db, 'users', userId));
    setNotice(t('userRemoved'));
  } catch (error) {
    reportError(error);
  }
}

async function removeLedgerEntry(entryId) {
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'ledger', entryId));
    ledgerImagesForEntry(entryId).forEach((image) => {
      batch.delete(doc(db, 'ledgerImages', image.id));
    });
    if (selectedLedgerImageEntryId === entryId) {
      selectedLedgerImageEntryId = '';
      selectedLedgerImageIndex = 0;
    }
    if (editingLedgerEntryId === entryId) {
      editingLedgerEntryId = '';
    }
    await batch.commit();
    setNotice(t('entryRemoved'));
  } catch (error) {
    reportError(error);
  }
}

async function toggleLedgerEntryCleared(entryId) {
  const entry = ledgerEntries.find((item) => item.id === entryId);
  if (!entry || !canManageEntry(entry)) return;

  try {
    const cleared = !entry.cleared;
    await updateDoc(doc(db, 'ledger', entryId), { cleared });
    setNotice(t(cleared ? 'entryCleared' : 'entryRestored'));
  } catch (error) {
    reportError(error);
  }
}

function stopActiveListeners() {
  stopLedger?.();
  stopLedgerImages?.();
  stopUsers?.();
  stopLedger = undefined;
  stopLedgerImages = undefined;
  stopUsers = undefined;
  ledgerEntries = [];
  ledgerImages = new Map();
  activeUsers = [];
}

function watchActiveData() {
  stopActiveListeners();
  const usersSource = profile.role === 'admin'
    ? collection(db, 'users')
    : query(collection(db, 'users'), where('status', '==', 'active'));

  stopUsers = onSnapshot(usersSource, (snapshot) => {
    activeUsers = snapshot.docs
      .map((item) => ({
        id: item.id,
        ...item.data(),
      }))
      .sort((left, right) => userAlias(left).localeCompare(userAlias(right)));
    render();
  }, listenerError('Users'));

  stopLedger = onSnapshot(collection(db, 'ledger'), (snapshot) => {
    ledgerEntries = snapshot.docs
      .map((item) => ({
        id: item.id,
        ...item.data(),
      }))
      .sort((left, right) => createdAtValue(right) - createdAtValue(left));
    render();
  }, listenerError('Ledger'));

  stopLedgerImages = onSnapshot(collection(db, 'ledgerImages'), (snapshot) => {
    ledgerImages = new Map();
    snapshot.docs.forEach((item) => {
      const data = item.data();
      let entryId = '';
      let imageRecord = null;

      if (
        typeof data.ledgerId === 'string'
        && data.ledgerId
        && isValidLedgerImageDataUrl(data.dataUrl)
      ) {
        entryId = data.ledgerId;
        imageRecord = {
          id: item.id,
          ...data,
        };
      } else if (isValidLedgerImageDataUrl(data.dataUrl)) {
        entryId = item.id;
        imageRecord = {
          id: item.id,
          ...data,
        };
      }

      if (!entryId || !imageRecord) return;
      if (!ledgerImages.has(entryId)) ledgerImages.set(entryId, []);
      ledgerImages.get(entryId).push(imageRecord);
    });

    ledgerImages.forEach((images, entryId) => {
      images.sort((left, right) => createdAtValue(left) - createdAtValue(right));
      ledgerImages.set(entryId, images);
    });

    if (selectedLedgerImageEntryId) {
      const entry = ledgerEntryById(selectedLedgerImageEntryId);
      const images = ledgerImagesForEntry(selectedLedgerImageEntryId);
      if (!entry || (!images.length && !canManageEntry(entry))) {
        selectedLedgerImageEntryId = '';
        selectedLedgerImageIndex = 0;
        pendingLedgerImageFocus = null;
      } else {
        if (pendingLedgerImageFocus?.entryId === selectedLedgerImageEntryId) {
          const focusIndex = images.findIndex(
            (image) => image.id === pendingLedgerImageFocus.imageId,
          );
          if (focusIndex !== -1) {
            selectedLedgerImageIndex = focusIndex;
            pendingLedgerImageFocus = null;
          }
        } else if (selectedLedgerImageIndex >= images.length) {
          selectedLedgerImageIndex = Math.max(0, images.length - 1);
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

onAuthStateChanged(auth, (user) => {
  clearAllListeners();
  authUser = user;
  profile = null;
  activeView = 'ledger';
  activeAdminTab = 'users';
  notice = '';
  settings = defaultSettings();
  adminCurrencySettings = null;
  initialCurrencyRatesSeeded = false;
  pendingLedgerImageFocus = null;

  if (!user) {
    render();
    return;
  }

  stopSettings = onSnapshot(settingsReference, (snapshot) => {
    const nextSettings = snapshot.exists() ? snapshot.data() : {};
    settings = normalizeSettings(nextSettings);
    adminCurrencySettings = null;
    if (profile?.status === 'active') {
      void seedInitialCurrencyRates();
    }
    render();
  }, listenerError('App settings'));

  stopProfile = onSnapshot(doc(db, 'users', user.uid), (snapshot) => {
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
    if (profile.status === 'active') {
      watchActiveData();
      void seedInitialCurrencyRates();
    } else stopActiveListeners();
    render();
  }, listenerError('Profile'));
});
