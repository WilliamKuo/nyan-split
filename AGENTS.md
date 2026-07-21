# 🤖 AI Agent Development Guide

This document helps AI agents understand the NyanSplit project structure and perform common development and deployment tasks.

## Project Overview

NyanSplit is a Firebase-based shared accounting ledger with administrator approval. It's a **single-page application** using vanilla JavaScript with Firebase SDK for backend services.

- **Frontend**: Vanilla JS (no framework), single `public/` directory
- **Backend**: Firebase (Authentication, Firestore, Hosting)
- **Architecture**: Client-side only, no Node.js or build step required
- **Deployment**: Firebase Hosting + Firestore rules

## Project Structure

```
/
├── public/                  # Static files served by Firebase Hosting
│   ├── app.js              # Main application logic (~2000 lines)
│   ├── firebase-config.js  # Firebase configuration (public API keys)
│   ├── i18n.js             # Bilingual translations (English/中文)
│   ├── style.css           # Application styles
│   ├── index.html          # Single page entry point
│   ├── manifest.json       # PWA manifest
│   ├── sw.js               # Service worker for offline support
│   ├── VERSION             # Current version (1.0.0-rc)
│   └── vendor/             # Third-party libraries (QRCode, etc.)
├── firestore.rules         # Firestore security rules (CRITICAL)
├── firebase.json           # Firebase hosting configuration
├── .firebaserc             # Firebase project ID
└── README.md               # User documentation
```

## Key Files to Understand

### `public/app.js` (Main Application)
- **State management**: Global variables at top (~line 70-95)
- **Views**: `ledger`, `account`, `share`, `add-entry`, `conversion`, `admin-users`, `admin-currencies`
- **Core functions**:
  - Authentication: Lines 27-28 (Firebase Auth imports)
  - Firestore operations: Lines 1469+ (CRUD operations)
  - Balance calculations: Lines 420-433
  - Settlement algorithm: Lines 435-507
  - Currency conversion: Lines 509-623
  - Image compression: Lines 726-754

### `firestore.rules` (Security)
**CRITICAL**: All data security is enforced here. Firebase API keys are public; security comes from these rules.

- User roles: `pending`, `active`, `admin`
- Collections: `users`, `ledger`, `ledgerImages`, `settings`
- Key functions: `signedIn()`, `active()`, `admin()`

### `public/i18n.js` (Translations)
- Two language objects: `en` and `zh`
- Current language stored in `localStorage`
- Add new translations for new features here

## Common Development Tasks

### 1. Adding a New Feature

**Steps**:
1. **Read existing code** first to understand patterns
2. **Check security implications** - update `firestore.rules` if adding/modifying data
3. **Add translations** in `public/i18n.js` (both `en` and `zh`)
4. **Test locally** with `python3 -m http.server --directory public`
5. **Test Firestore rules** with Firebase Emulator or careful manual testing
6. **Update README.md** if adding user-facing features

**Example**: Adding a new field to ledger entries
```javascript
// 1. Update app.js CRUD functions
// 2. Update firestore.rules to validate the new field
// 3. Add UI in renderLedgerRows() or renderLedgerEntryEdit()
// 4. Add translation keys in i18n.js
```

### 2. Modifying Firestore Security Rules

**CRITICAL SAFETY**: Always test rules before deploying to production!

```bash
# Deploy only rules (no hosting changes)
firebase deploy --only firestore:rules

# Deploy everything
firebase deploy
```

**Testing approach**:
1. Read existing rule patterns (lines 1-141 in `firestore.rules`)
2. Understand helper functions: `signedIn()`, `active()`, `admin()`, `allowedCurrency()`
3. Add new rules following the same pattern
4. Test with different user roles: unauthenticated, pending, active, admin
5. Verify rejection cases work correctly

### 3. Local Development

**Start local server**:
```bash
# From project root
python3 -m http.server --directory public 8000

# Or use any static file server
cd public && python3 -m http.server
```

**Access**: http://localhost:8000

**Note**: Firebase services (Auth, Firestore) connect to production. There's no local emulator setup.

### 4. Deployment

**Prerequisites**:
- Firebase CLI installed: `npm install -g firebase-tools`
- Logged in: `firebase login`
- Project selected: `firebase use nyan-split`

**Deploy commands**:
```bash
# Deploy everything (hosting + rules)
firebase deploy

# Deploy only hosting (safe, no security changes)
firebase deploy --only hosting

# Deploy only Firestore rules (CAREFUL - affects security)
firebase deploy --only firestore:rules

# Deploy specific targets
firebase deploy --only hosting,firestore
```

**Deployment checklist**:
1. ✅ Test locally first
2. ✅ Check git status (commit changes if needed)
3. ✅ Review `firestore.rules` changes carefully
4. ✅ Update `VERSION` file if making a release
5. ✅ Run deployment command
6. ✅ Test deployed app immediately
7. ✅ Check Firebase Console for errors

### 5. Updating Translations

**Pattern**:
```javascript
// public/i18n.js
const translations = {
  en: {
    newFeature: 'New Feature',
    newFeatureHelp: 'This is a new feature description.',
    // ...
  },
  zh: {
    newFeature: '新功能',
    newFeatureHelp: '這是新功能說明。',
    // ...
  },
};
```

**Usage in app.js**:
```javascript
const label = t('newFeature');
const helpText = t('newFeatureHelp');
```

### 6. Working with Images

**Current implementation**:
- Images stored as base64 data URLs in Firestore (`ledgerImages` collection)
- Compressed to JPEG before upload (see `compressLedgerImage()` line 726)
- Max size: 700KB (enforced by `firestore.rules`)
- Max dimension: 1600px, Min dimension: 480px

**To modify image handling**:
1. Update constants at top of `app.js` (lines 37-40)
2. Modify `compressLedgerImage()` function
3. Update size limit in `firestore.rules` line 132

### 7. Currency Management

**Architecture**:
- Admins control allowed currencies in `settings/app` document
- Users save personal conversion rates in their profile
- Rates fetched from ExchangeRate API (free tier)
- Blank user rates fall back to public API rates

**To add currency features**:
1. Update `COMMON_CURRENCIES` array (line 43-64)
2. Modify currency conversion logic (lines 509-623)
3. Update `allowedCurrency()` validation in `firestore.rules`

## Firestore Data Schema

### `users/{uid}`
```javascript
{
  alias: string,           // Display name (max 40 chars)
  email: string,           // From Firebase Auth
  photoURL: string,        // From Firebase Auth
  role: 'user' | 'admin',
  status: 'pending' | 'active',
  resultCurrency: string,  // User's preferred display currency
  currencyRates: {         // Optional custom rates
    [currency]: number
  },
  createdAt: timestamp,
  updatedAt: timestamp
}
```

### `ledger/{entryId}`
```javascript
{
  creditorId: string,      // UID of person who is owed
  debtorId: string,        // UID of person who owes
  amount: number,          // Positive number
  currency: string,        // 3-letter code (TWD, USD, etc.)
  note: string,            // Description
  cleared: boolean,        // If true, excluded from balance calculations
  createdBy: string,       // UID of creator
  createdAt: timestamp
}
```

### `ledgerImages/{imageId}`
```javascript
{
  ledgerId: string,        // Reference to ledger entry
  dataUrl: string,         // Base64 JPEG (max 700KB)
  createdBy: string,       // UID of creator
  createdAt: timestamp
}
```

### `settings/app`
```javascript
{
  defaultCurrency: string,      // Admin's default (e.g., 'TWD')
  allowedCurrencies: string[]   // Array of 3-letter codes
}
```

## Security Model

**Authentication Flow**:
1. User signs in with Google or Anonymous
2. Account created with `status: 'pending'`
3. Admin manually approves → `status: 'active'`
4. Only active users can access ledger data

**Authorization Levels**:
- **Unauthenticated**: Can only sign in
- **Pending**: Can view own profile, waiting for approval
- **Active**: Can read/write ledger, manage own entries
- **Admin**: Can approve users, manage currencies, delete any entry

**Critical Rules**:
- Only active users can read/write ledger
- Users can only modify their own profile (except admin)
- Ledger entries must use allowed currencies
- Admin-only operations gated by `admin()` function

## Testing Checklist

When making changes, test these scenarios:

### Authentication & Authorization
- [ ] Unauthenticated user cannot access data
- [ ] Pending user sees waiting message
- [ ] Active user can view ledger
- [ ] Non-admin cannot access admin features
- [ ] Admin can approve/reject users

### Ledger Operations
- [ ] Create entry with valid currency
- [ ] Cannot create entry with invalid currency
- [ ] Edit own entry
- [ ] Cannot edit others' entry (non-admin)
- [ ] Delete own entry
- [ ] Toggle cleared status
- [ ] Entries with cleared=true excluded from balance

### Currency & Conversion
- [ ] Admin can add/remove currencies
- [ ] Users see only allowed currencies
- [ ] Personal rates override public rates
- [ ] Balance calculation uses correct rates
- [ ] Settlement plan calculates correctly

### Images
- [ ] Upload image to ledger entry
- [ ] Image compressed properly
- [ ] Cannot upload oversized image (>700KB)
- [ ] Delete image
- [ ] View multiple images per entry

### PWA Features
- [ ] App installs on mobile
- [ ] Service worker caches assets
- [ ] App shell loads offline
- [ ] Firebase operations fail gracefully offline

## Common Pitfalls

### 1. **Firestore Rules Too Permissive**
❌ Don't: `allow read, write: if true;`
✅ Do: Always check `active()` for ledger operations

### 2. **Hardcoded Firebase Config**
✅ Config in `firebase-config.js` is intentionally public
✅ Security is enforced by Firestore rules, not by hiding keys

### 3. **Missing Translations**
❌ Hardcoded English strings in `app.js`
✅ Always use `t('translationKey')` and add to both `en` and `zh`

### 4. **Breaking Changes to Data Schema**
⚠️ Firestore has live production data
⚠️ Test schema changes with backward compatibility
⚠️ Consider migration strategy for existing documents

### 5. **Image Size Issues**
⚠️ Images must be under 700KB after compression
⚠️ Test with actual photos, not small test images
⚠️ Handle compression failures gracefully

## Useful Firebase Console Links

- **Authentication**: https://console.firebase.google.com/project/nyan-split/authentication
- **Firestore**: https://console.firebase.google.com/project/nyan-split/firestore
- **Hosting**: https://console.firebase.google.com/project/nyan-split/hosting
- **Security Rules**: https://console.firebase.google.com/project/nyan-split/firestore/rules

## Environment & Dependencies

### No Build Process
This project has NO build step. It's pure HTML/CSS/JS served statically.

**No npm/yarn**: No `package.json`, no `node_modules/`
**No bundler**: No webpack, Vite, Rollup, etc.
**No TypeScript**: Plain JavaScript (ES6+ modules)
**No framework**: Vanilla JS DOM manipulation

### External Dependencies (CDN)
- Firebase SDK 11.6.1 (loaded from CDN in `app.js`)
- QRCode.js (in `vendor/` directory)

### System Requirements
- Python 3 (for local dev server, or any alternative)
- Firebase CLI (for deployment)
- Modern browser with ES6 module support

## Making Your First Change

**Example: Add a "description" field to user profiles**

1. **Update `app.js`**:
```javascript
// In renderAccount() function
<input 
  type="text" 
  name="description" 
  value="${escapeHtml(profile.description || '')}"
  placeholder="${escapeHtml(t('userDescription'))}"
/>

// In saveAccount() function
await updateDoc(doc(db, 'users', authUser.uid), {
  alias: cleanAlias(form.alias.value),
  description: form.description.value.trim().slice(0, 200),
  updatedAt: serverTimestamp(),
});
```

2. **Update `firestore.rules`**:
```javascript
// In match /users/{userId}, allow update:
&& request.resource.data.diff(resource.data).affectedKeys()
  .hasOnly(['alias', 'resultCurrency', 'currencyRates', 'updatedAt', 'description'])
&& (!request.resource.data.keys().hasAll(['description'])
  || (request.resource.data.description is string 
    && request.resource.data.description.size() <= 200))
```

3. **Add translations** in `i18n.js`:
```javascript
en: {
  userDescription: 'Description',
  // ...
},
zh: {
  userDescription: '描述',
  // ...
}
```

4. **Test locally**:
```bash
python3 -m http.server --directory public 8000
# Open browser, sign in, edit profile
```

5. **Deploy**:
```bash
firebase deploy
```

## Questions to Ask Yourself

Before making changes:
- [ ] Do I understand the security implications?
- [ ] Do I need to update Firestore rules?
- [ ] Have I added translations for both languages?
- [ ] Is this change backward compatible with existing data?
- [ ] Have I tested with different user roles?
- [ ] Does this work offline (if applicable)?

## Getting Help

- **Firebase Documentation**: https://firebase.google.com/docs
- **Firestore Rules**: https://firebase.google.com/docs/firestore/security/get-started
- **PWA Guide**: https://web.dev/progressive-web-apps/

## Version History

- **1.0.0-rc**: Current release candidate
  - All core features implemented
  - Receipt image attachments
  - Entry clearing
  - Multi-currency with custom rates
  - Settlement plan optimization

---

**Remember**: This is a production app with real users. Test thoroughly and deploy carefully! 🚀
