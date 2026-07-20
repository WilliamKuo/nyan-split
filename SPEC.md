🌈🐱 NyanSplit

> Firebase-based cost splitting web app with admin approval (free-tier only)

---

# 0. Project Steps (Execution Order)

1. Setup Firebase project
2. Implement Authentication (Google Login + Pending Approval)
3. Build Admin Approval System
4. Implement Group System
5. Implement Expense System
6. Implement Balance Calculation
7. Implement Settlement System
8. Apply Security Rules
9. (Optional) Add OCR via Tesseract.js

---

# 1. Step 1 — Project Setup

## Tasks

* Create Firebase project
* Enable:

  * Authentication (Google)
  * Firestore
  * Storage (optional)

## Ownership

* Basic AI:

  * Generate Firebase config integration code
* Human Manual:

  * Create Firebase project
  * Enable Google provider
  * Configure domain

---

# 2. Step 2 — Authentication Flow

## Goal

Login + admin approval gating

## Flow

1. User logs in with Google
2. If first login:

   * Create Firestore user doc
   * status = `pending`
3. Block system access unless `active`

## Schema

```json id="zv2z7r"
users/{uid}
{
  "email": "...",
  "name": "...",
  "photoURL": "...",
  "status": "pending",
  "role": "user",
  "createdAt": timestamp
}
```

## Ownership

* Basic AI:

  * Login UI + Firebase Auth integration
* Smart AI:

  * Access gating logic (route protection)
* Human Manual:

  * Verify no bypass via direct API calls

---

# 3. Step 3 — Admin Approval System

## Goal

Only approved users can use system

## Features

* View pending users
* Approve / reject users
* Promote user to admin

## Ownership

* Basic AI:

  * Admin dashboard UI
* Smart AI:

  * Firestore security rules for admin-only actions
* Human Manual:

  * Test privilege escalation (critical)

---

# 4. Step 4 — Shared Ledger

## Features

* One shared ledger for every approved user
* Each row records the person who paid and the person who owes
* Results show only the signed-in user's net balance

## Schema

```json id="b6x5l0"
ledger/{entryId}
{
  "debtorId": "uidA",
  "creditorId": "uidB",
  "amount": 1000,
  "currency": "TWD",
  "createdBy": "uidA",
  "createdAt": timestamp
}
```

---

# 5. Step 5 — Registration and Currency

## Features

* Alias defaults to the Google display name and is optional to edit
* Administrators maintain the allowed three-letter currency codes and choose the default
* Each ledger row can use any administrator-allowed currency
* Each user can save a result currency and personal conversion-rate overrides
* Saved user rates are applied when balances and settlements are calculated

---

# 6. Step 6 — Balance Calculation

## Goal

Compute who owes who

## Approach

* Compute dynamically on frontend from shared ledger rows
* Show only the signed-in user's result
* Show all active users' balances and a minimum-transfer settlement plan in the default currency

## Example

```id="f9g1mj"
A paid 1000
B owes A 500
C owes A 500
```

## Ownership

* Smart AI:

  * Balance algorithm design
* Basic AI:

  * UI rendering of balances
* Human Manual:

  * Validate correctness across scenarios

---

# 7. Step 7 — Security Rules

## Requirements

* Only approved users can access ledger data
* Only admin can approve users
* Users can only modify their own profile
* User currencies and new ledger rows must use an administrator-allowed currency

## Example (Concept)

```js id="c3v8kp"
match /ledger/{entryId} {
  allow read: if active();
}
```

## Ownership

* Smart AI:

  * Full Firestore rules design
* Human Manual:

  * Simulate attacks and verify protection

---

# 8. Step 8 — OCR (Optional)

## Tool

* Tesseract.js (browser-side OCR)

## Flow

1. Upload receipt image
2. Run OCR locally in browser
3. Extract total manually

## Ownership

* Basic AI:

  * OCR integration
* Human Manual:

  * Decide usability (accuracy is limited)

---

# 9. Structure

```id="l6q2wr"
/public
  app.js
  firebase-config.js
  i18n.js
  index.html
  style.css
```

---

# END
