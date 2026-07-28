# 🌈🐱 NyanSplit

A Firebase-based shared accounting ledger with administrator approval.

## Features

- **Multi-user shared ledger** – Track direct debts between users
- **Admin approval workflow** – New registrations require administrator approval
- **Multi-currency support** – Admins manage allowed currencies; users set personal conversion rates
- **Receipt attachments** – Add photos or receipts to ledger entries (compressed to JPEG)
- **Entry clearing** – Mark entries as cleared to exclude them from balance calculations
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
   - Sign in to the deployed app (your account will be created as `pending`).
   - In Firebase Console > Firestore (`users` collection), find your UID and update `role: "admin"` and `status: "active"`.

## Security model

Only active accounts can access the shared ledger. Each ledger entry records a direct debt: one user owes another user an amount. The result card shows only the signed-in user's net balance. User approval, rejection, profile removal, and currency-allowlist changes are restricted to administrators by `firestore.rules`. Deploy those rules before treating the app as usable.

Anonymous sign-ins follow the same registration and approval flow as Google sign-ins. Removing an active user marks their Firestore profile as `removed`, clears their email, photo, and custom rates, revokes app access, and retains their alias for ledger history. Removing a pending or rejected registration deletes its Firestore profile. Neither operation deletes the Firebase Authentication account; that requires a trusted backend using the Firebase Admin SDK.

## Languages

New or unconfigured apps allow only TWD, which is also the default currency. In the Settings Currencies tab, an administrator can add currencies such as JPY or USD, remove them, and choose the default. Each ledger row can use any allowed currency, initially selecting the administrator's default. At the bottom of Ledger, each user can save a result currency and optional personal conversion-rate overrides expressed in that result currency. Blank rate fields use the public ExchangeRate API rate. Currency codes use three uppercase ISO letters. Ledger rows store only their original amount and currency; every user's balances and suggested transfers are calculated using that user's current saved rate settings.

The ledger shows every active user's net balance and a settlement plan that minimizes the number of transfers. Mixed-currency rows are converted using the signed-in user's saved result currency and rate settings.

The Share & install page provides a copyable site URL and QR code. NyanSplit includes a web manifest and service worker, so supported browsers can install it as a PWA. The app shell can open offline, but Google sign-in and Firebase data still need a connection.

Use the English/中文 button in the header to switch languages. The choice is saved in the browser; translations live in `public/i18n.js`.
