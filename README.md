# 🌈🐱 NyanSplit

A Firebase-based shared accounting ledger with administrator approval.

## Features

- **Grouped shared expenses** – Track several users owing one payer under a shared note, currency, and receipt
- **Admin approval workflow** – New registrations require administrator approval
- **Admin user controls** – Manage roles, reversible access, and who can be selected in new ledger entries
- **Google-only administrators** – Anonymous and manually created users cannot receive the administrator role
- **Multi-currency support** – Admins manage allowed currencies; users set personal conversion rates
- **Receipt attachments** – Add shared photos or receipts to an expense (compressed to JPEG)
- **Admin ledger backups** – Export and safely add missing ledger records from one ZIP file
- **Flexible debt clearing** – Clear one debt or every debt in an expense to exclude them from balance calculations
- **Net balance calculation** – See your personal balance across all currencies
- **Optimized settlement plan** – Minimizes the number of transfers needed
- **PWA installable** – Add to home screen on supported devices
- **Offline-capable shell** – App opens offline, but requires connection for data
- **Bilingual interface** – Switch between English and 中文

## Deployment

1. **Firebase Console Setup**: Create a Firebase project, enable **Google** and **Anonymous** sign-in providers under Authentication (add your host domain to Authorized Domains), and create a **Firestore Database**.
2. **Update Configuration**:
   - Edit `public/firebase-config.js` and replace with your Firebase Web App credentials:
     ```javascript
     export const firebaseConfig = {
       apiKey: 'YOUR_API_KEY',
       authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
       projectId: 'YOUR_PROJECT_ID',
       storageBucket: 'YOUR_PROJECT_ID.firebasestorage.app',
       messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
       appId: 'YOUR_APP_ID',
     };
     ```
   - Edit `.firebaserc` and set your Firebase project ID:
     ```json
     {
       "projects": {
         "default": "YOUR_PROJECT_ID"
       }
     }
     ```
3. **Deploy App & Security Rules**:
   ```bash
   firebase login
   firebase use YOUR_PROJECT_ID
   firebase deploy
   ```
4. **Bootstrap Initial Admin**:
   - Sign in with Google and complete registration. Do not use an anonymous or manually created user for the initial administrator.
   - In Firebase Console > Firestore, verify that `users/{uid}` exists and that `userAuth/{uid}` contains exactly `{ provider: "google.com" }`.
   - Update only the matching `users/{uid}` document to set `role: "admin"` and `status: "active"`. Do not create or edit the protected `userAuth` marker manually.

## Security model

Only active, non-disabled accounts can access the shared ledger. Each ledger entry represents one expense with a shared payer, note, currency, and set of images. Its `ledgerSplits` documents record the individual users and amounts owed to that payer. Each debt can be cleared independently, while the expense controls can clear, restore, or remove all of its debts together. The result card shows only the signed-in user's net balance. User approval, rejection, role changes, disabling, ledger selectability, profile removal, and currency-allowlist changes are restricted to administrators by `firestore.rules`. Deploy those rules before treating the app as usable.

Assigning the administrator role requires a matching `userAuth/{uid}` document whose provider is `google.com`. Only that signed-in Google identity can create or repair its own marker, so administrators cannot promote anonymous or manually created users by changing profile data alone.

Anonymous sign-ins follow the same registration and approval flow as Google sign-ins. Disabling a user is reversible: it preserves their status, role, profile, ledger selectability setting, and history while revoking app access. A missing `disabled` field is treated as `false` for existing profiles. Removing an active user instead marks their profile as `removed`, clears their email, photo, and custom rates, resets `disabled`, demotes them to `user`, revokes app access, and retains their alias for ledger history. Removing a pending or rejected registration deletes its Firestore profile. Neither operation deletes the Firebase Authentication account; that requires a trusted backend using the Firebase Admin SDK.

## Ledger and currency behavior

New or unconfigured apps allow only TWD, which is also the default currency. In the Settings Currencies tab, an administrator can add currencies such as JPY or USD, remove them, and choose the default. Each expense uses one allowed currency shared by all of its debts, initially selecting the administrator's default. At the bottom of Ledger, each user can save a result currency and optional personal conversion-rate overrides expressed in that result currency. Blank rate fields use the public ExchangeRate API rate. Currency codes use three uppercase ISO letters. Expenses and debts retain their original currency and amounts; every user's balances and suggested transfers are calculated using that user's current saved rate settings.

The ledger shows net balances and a settlement plan that minimizes the number of transfers. Only uncleared debts contribute to balances. Mixed-currency expenses are converted using the signed-in user's saved result currency and rate settings.

An active, non-disabled user is available as a payer or owing user in new ledger entries when `ledgerSelectable` is `true`. Setting it to `false` removes the user from those choices without deleting or hiding their existing ledger history. Existing profiles with no `ledgerSelectable` field are treated as selectable, and new registered or manually created profiles explicitly default it to `true`.

## Ledger backup and restore

Administrators can open Account and use **Export and import ledger data** to download one ZIP containing every expense, debt, and receipt image. Export reads the latest server data rather than relying on the browser cache. The backup preserves Firestore document IDs, creators, and timestamps.

Import validates the complete archive before writing, then adds only missing documents. Existing document IDs are skipped and never overwritten. If an existing expense ID points to different expense data, import stops before making changes so its debts and images cannot be mixed with the backup. If a connection fails partway through, importing the same ZIP again safely resumes the remaining records.

To protect browser memory, import rejects ZIP files larger than 64 MiB, uncompressed backup data larger than 128 MiB, archives containing extra entries, and backups containing more than 100,000 records.

Backups do not contain user accounts, Firebase Authentication identities, app settings, or personal currency rates. Every referenced active or removed user profile must already exist, and every expense currency must already be in **Allowed currencies**. Deploy the matching `firestore.rules` changes with the app; the restore path needs those narrowly scoped administrator permissions to preserve historical creators and timestamps.

## Firestore data model

A user profile is stored in `users/{userId}`:

```javascript
{
  alias: 'Display name',
  createdAt: timestamp,
  currencyRates: {
    USD: 32.5,
  },
  disabled: false,
  email: 'user@example.com',
  ledgerSelectable: true,
  photoURL: 'https://example.com/photo.jpg',
  resultCurrency: 'TWD',
  role: 'user',
  status: 'active',
  updatedAt: timestamp,
}
```

`role` is either `user` or `admin`; `status` is `pending`, `active`, `rejected`, or `removed`. A Google-backed user also has a protected authorization marker in `userAuth/{uid}`:

```javascript
{
  provider: 'google.com',
}
```

Anonymous and manually created users do not have this marker and therefore cannot become administrators.

An expense stores its shared fields in `ledger/{entryId}`:

```javascript
{
  creditorId: 'payer-user-id',
  createdAt: timestamp,
  createdBy: 'creator-user-id',
  currency: 'TWD',
  note: 'Restaurant dinner',
  updatedAt: timestamp,
}
```

Each amount owed is stored separately in `ledgerSplits/{splitId}`:

```javascript
{
  amount: 100,
  cleared: false,
  createdAt: timestamp,
  debtorId: 'owing-user-id',
  ledgerId: 'expense-id',
  position: 0,
  updatedAt: timestamp,
}
```

Split document IDs combine the expense and owing-user IDs, so an owing user appears at most once in an expense. `position` preserves the display order. The interface limits an expense to 12 debts.

Attachments remain separate and point to the shared expense:

```javascript
// ledgerImages/{imageId}
{
  createdAt: timestamp,
  createdBy: 'creator-user-id',
  dataUrl: 'data:image/jpeg;base64,...',
  ledgerId: 'expense-id',
}
```

Every debt in the expense therefore shares the same attachments.

Creating or saving an expense writes its header and debts together. Removing the whole expense also removes its debt and image documents. Removing the final debt from the editor is therefore treated as removing the complete expense.

## Installation and languages

The Share & install page provides a copyable site URL and QR code. NyanSplit includes a web manifest and service worker, so supported browsers can install it as a PWA. The app shell can open offline, but Google sign-in and Firebase data still need a connection.

Use the English/中文 button in the header to switch languages. The choice is saved in the browser; translations live in `public/i18n.js`.
