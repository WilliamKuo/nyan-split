# 🌈🐱 NyanSplit

A Firebase-based shared accounting ledger with administrator approval.

## Run locally

1. The app is configured for the `nyan-split` Firebase project. Enable Google and Anonymous Authentication, plus Firestore, there.
2. To preview it locally, run a static server from `public/` (for example, `python3 -m http.server --directory public`).
3. Deploy the app and rules with `firebase deploy`.

On first sign-in, a user can keep or change their Google display name as an alias. The account is then created as `pending`. In Firestore, manually set one trusted account's `role` to `admin` and `status` to `active`; that account can approve or reject future registrations from the app.

## Security model

Only active accounts can access the shared ledger. Each ledger entry records a direct debt: one user owes another user an amount. The result card shows only the signed-in user's net balance. User approval, rejection, profile removal, and currency-allowlist changes are restricted to administrators by `firestore.rules`. Deploy those rules before treating the app as usable.

Anonymous sign-ins follow the same registration and approval flow as Google sign-ins. Removing a user deletes their Firestore profile and revokes their app access, but retains ledger history and does not delete their Firebase Authentication account. Deleting Firebase Authentication accounts requires a trusted backend using the Firebase Admin SDK.

## Languages

New or unconfigured apps allow only TWD, which is also the default currency. In the Settings Currencies tab, an administrator can add currencies such as JPY or USD, remove them, and choose the default. Each ledger row can use any allowed currency, initially selecting the administrator's default. At the bottom of Ledger, each user can save a result currency and optional personal conversion-rate overrides expressed in that result currency. Blank rate fields use the public ExchangeRate API rate. Currency codes use three uppercase ISO letters. Ledger rows store only their original amount and currency; every user's balances and suggested transfers are calculated using that user's current saved rate settings.

The ledger shows every active user's net balance and a settlement plan that minimizes the number of transfers. Mixed-currency rows are converted using the signed-in user's saved result currency and rate settings.

The Share & install page provides a copyable site URL and QR code. NyanSplit includes a web manifest and service worker, so supported browsers can install it as a PWA. The app shell can open offline, but Google sign-in and Firebase data still need a connection.

Use the English/中文 button in the header to switch languages. The choice is saved in the browser; translations live in `public/i18n.js`.
