# Member pairing API (Block 3A, not deployed)

Mounted at `/api/member-sync`. All endpoints require a Firebase anonymous ID
token in `Authorization: Bearer ...`, verified with revocation checking using
the dedicated `member-sync-admin` App. Auth and Firestore are both bound to
`gbf-meron-portal`. No AI/default/FCM client is reused; initialization errors
fail closed. This module does not initialize Firebase at import time.

## Configuration before production deployment

- Confirm the Cloud Run execution service account and its IAM permissions for
  **gbf-meron-portal** Firestore and Firebase Auth (including revoked-user checks).
- Enable Anonymous Auth in that project only when production rollout is approved.
- Provision a cryptographically random secret (at least 32 random bytes) through
  Secret Manager as `MEMBER_SYNC_HMAC_SECRET`. Never put it in source or an image.
- Optional `MEMBER_SYNC_PROJECT_ID` must be exactly `gbf-meron-portal`; any other
  value is rejected. `FIRESTORE_PROJECT_ID` is deliberately unused.
- Never set emulator host variables in production. Local tests require both
  `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` and
  `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099` and use anonymous credentials.

No Console, IAM, Secret Manager or deployment changes are made in this block.

## Endpoints

| Method/path | JSON body | Result |
| --- | --- | --- |
| POST `/profile` | `{}` | Create profile/identity/device atomically, or return ready for existing active membership |
| GET `/status` | none | Restore only the verified caller's ready/unconfigured/pending/rejected/revoked/expired state; no identifiers returned |
| POST `/invites` | `{}` | Return code, requestId, expiresAt; revoke issuer's previous unused invite |
| POST `/invites/claim` | `{"code":"...","label":"optional"}` | Reserve invite as pending, **without** creating membership |
| GET `/invites/pending` | none | Only caller profile's unexpired pending request IDs, labels and request times |
| POST `/invites/{requestId}/approve` | `{}` | Atomically create identity/device, increment deviceCount, consume invite |
| POST `/invites/{requestId}/reject` | `{}` | Permanently reject pending invite |
| POST `/invites/{requestId}/revoke` | `{}` | Issuer only; revoke issued or pending invite |

Bodies are limited to 2048 bytes. Unknown fields, including uid/profileId/deviceId,
are rejected. Label max 40 characters, no control characters; request IDs are
32 lowercase hex characters. All responses are `Cache-Control: no-store`.

Codes use 12 independent cryptographic choices from
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (60 bits), expire after 10 minutes and
are never persisted or logged. Outer whitespace is stripped and lowercase is
uppercased; internal separators are not accepted. HMAC-SHA256 is the document
key in `memberSyncInvites`, with `keyVersion: 1`. Server timestamps are derived
from UTC server time on each transaction attempt; TTL deletion is not trusted.
Secret rotation invalidates old codes; coordinate rotation as a separate rollout.

`memberSyncRequests` maps random request IDs to digests; `memberSyncIssuers` tracks
each issuer's current digest. `memberSyncPending/{profileId}/requests/{requestId}`
is an atomic pending projection, avoiding broad/composite-index queries. All
pairing collections and `memberSyncLimits` are denied to clients by the existing
Firestore catch-all rule. Admin SDK is the only writer.

UID-keyed identity creation makes profile retries idempotent without trusting a
client requestId. Concurrent creation cannot produce duplicate committed profiles.
Repeated claim by the same UID returns the existing pending ID; another UID loses
the race. Finalization can commit only once; repeat approve/reject returns 409.
All membership writers contend on profile.deviceCount, with a maximum of 5.
Missing/corrupt counters and inactive memberships fail closed, not reset silently.
No device removal API is added; a future server transaction must atomically revoke
identity/device, maintain the count, and invalidate that issuer's outstanding invite.

Per-minute transactional limits: 30 requests/UID, 100/socket IP, 1000 globally,
covering authenticated attempts, including invalid codes. HMAC-anonymized bucket
keys are kept in `memberSyncLimits`; expiry is cleanup metadata only. Forwarded IP
headers are not trusted. Shared Cloud Run proxy/NAT addresses may make the IP cap
conservative: review proxy topology and quotas before production. No other API's
quota is changed. Invalid tokens cannot cause Firestore reads/writes.

Errors expose categories only: UNAUTHENTICATED, MEMBERSHIP_REQUIRED,
INVITE_UNAVAILABLE (missing/expired/used/rejected/revoked), DEVICE_LIMIT,
RATE_LIMITED, INVALID_INPUT, INPUT_TOO_LARGE, NOT_READY. Raw validation inputs,
SDK exceptions, bearer tokens and secrets are neither logged nor returned.

## Local tests

```text
npx firebase emulators:exec --config firebase.member-sync-test.json --project gbf-meron-portal --only auth,firestore "python -m pytest -q -p no:cacheprovider tests/test_member_sync_api.py"
```

The project name intentionally exercises the fixed binding. The test fixture
asserts both localhost emulator hosts before SDK use, uses a random test-only
secret and AnonymousCredentials, and resets only that emulator's documents.
Run separately from older Python tests which globally monkeypatch SDK modules.
Existing JS Auth/Rules suites continue to use `demo-gbf-meron-portal-rules`.

## Block 3B UI (local only, not deployed)

`speed-calculator-folder/speed-calculator.html` contains the compact pairing
settings panel. `member-sync.css` scopes its styling; `member-sync.js` owns Auth,
API transport, state, polling and safe DOM updates. The root calculator and all
calculator scripts/storage formats remain unchanged. No settings are synced.

`restoreAuthentication()` waits for LOCAL persistence without signing in.
Only explicit start/claim actions call `startAuthentication()`. Named App
`member-sync` remains separate from default, yosen-shared and FCM Apps.
Profile creation never issues an invite automatically. Codes display as
`ABCD-EFGH-JKLM`; the client removes hyphens, trims and uppercases before sending
the existing 12-character API format. Clipboard copies the displayed format.

The claimant pointer `memberSyncClaimants/{verifiedUid}` is written atomically
with claim. GET `/status` follows only this caller's pointer, checks claimant UID,
and validates active identity/profile/device for ready. Request IDs or UIDs in
query parameters never select a different user. Client reads/writes of this new
collection are denied by the existing catch-all Rules. Status shares the existing
authentication, revocation checks, quota and no-store policy.

Visible ready/pending pages poll every 10 seconds. Ready polls check status and
the existing pending API (12 requests/minute, below the 30/UID cap). Transient
failures back off to 60 seconds; hidden pages skip calls; pagehide stops polling.
Reload restores pending from the server without storing codes/request IDs in
browser storage. Auth/membership loss clears privileged UI and stops polling.

### Browser fixture and checks

Block 6C-1 adds production configuration (not deployed). HTTPS pages reuse
`firebase-config.js` and its `API_BASE_URL`, appending `/api/member-sync`.
The SDK loader reuses existing compat components or loads the same 10.8.0
gstatic SDK as the portal. It does not block calculator initialization.
Page load restores LOCAL credentials in the `member-sync` named app only;
no user means no API calls or anonymous sign-in. Existing credentials trigger
status validation and the existing identity/settings restoration path.
Only explicit start/claim actions may create anonymous authentication.
The local config requires a loopback HTTP page, same-origin `/api/member-sync`,
project `gbf-meron-portal`, key `local-only`, and fixed localhost Auth/Firestore
emulators. Loopback pages never fall back to production. Non-loopback pages
reject `MEMBER_SYNC_LOCAL`. The browser fixture removes the production config
script; production-host tests fulfill/abort every network request and mock Auth,
Firestore and API calls. Shared config contains public identifiers, not secrets.
The member JS/CSS use `?v=6c1` in the calculator HTML. Bump both on future changes.
Recovery requires one surviving browser session; max five devices, with no
removal in V1. Both limits are stated in the existing sync panel.

See [Block 6C-1 audit and rollout plan](MEMBER_SYNC_6C1.md) before deployment.

`tests/member-sync-browser.py` is an allowlisted local asset server plus the real
pairing API; it never imports backend.main or uses ADC. It uses a random in-memory
test secret, local Firebase SDK assets and no external fonts. Run manually:

```text
npx firebase emulators:exec --config firebase.member-sync-test.json --project gbf-meron-portal --only auth,firestore "python tests/member-sync-browser.py"
```

Open `http://127.0.0.1:18765/speed-calculator-folder/speed-calculator.html`.
Use separate browser profiles/contexts for different devices.

Automated checks (existing Emulator config, no new build system):

```text
node --test tests/member-sync.client.test.cjs
npx firebase emulators:exec --config firebase.member-sync-test.json --project gbf-meron-portal --only auth,firestore "python -m pytest -q -p no:cacheprovider tests/test_member_sync_api.py && node tests/member-sync.browser.test.cjs"
```

The browser test uses the available Playwright runtime (`NODE_PATH` can point to
the Codex bundled node_modules) and installed Edge headless. It starts/stops the
fixture automatically, uses isolated 1440x1000 and 390x844 contexts, rejects
non-local browser requests, and saves screenshots to a fresh temporary directory
(or `MEMBER_SYNC_ARTIFACT_DIR`). Happy-flow console errors must be zero; explicit
HTTP/network failure cases can emit the browser's expected failed-resource logs,
but may not produce uncaught exceptions or break the calculator.

Legacy Python files monkeypatch process-global SDKs and use different mock admin
keys. Run each tracked root `test_*.py` in its own process, not in one pytest
collection; `test_knowledge_api.py` and `test_integration.py` are script assertions.
Keep the member API emulator tests in their own process as before.

QR codes, device removal, HELL/interval settings sync and conflict handling are
not implemented. No production Firebase/Cloud Run/Rules changes are required or
performed for this block.

## Block 4A-1: opt-in speed calculator storage (Emulator only)

No calculator HTML, input handlers or localStorage reads/writes are connected.
The following methods on `createMemberSync()` derive profile/device IDs from the
current anonymous user's server-read identity; callers cannot select those IDs:

- `getSpeedCalculatorSettings()` returns a validated frozen document or `null`.
- `initializeSpeedCalculatorSettings({hellTimesSec, intervalSec})` creates only
  if absent, in a transaction. An existing document is validated and returned
  without any write. All six HELL values must be supplied by the caller.
- `updateSpeedCalculatorField(path, value)` accepts only `hellTimesSec.90`, `.95`,
  `.100`, `.150`, `.200`, `.250` (each with the full `hellTimesSec` prefix), or
  `intervalSec`. It reads the latest document in a transaction, updates only that
  field plus audit metadata, and returns its committed revision. It does not
  initialize an absent document. Different-field concurrent updates survive;
  same-field updates use the final successful commit, without device clocks.
- `subscribeSpeedCalculatorSettings(onData, onError)` returns an unsubscribe
  function immediately, even before async identity lookup completes. It emits
  validated server-confirmed documents or `null`, skipping cached/pending writes.
  Unsubscribe, Auth loss, identity revocation/rebinding, invalid documents or
  listener errors detach the listeners. Errors use fixed categories only.

The sole permitted settings document is
`memberProfiles/{profileId}/settings/speedCalculator`. Exact V1 fields:
`schemaVersion`, `hellTimesSec`, `intervalSec`, `revision`, `createdAt`,
`updatedAt`, `updatedByDeviceId`. HELL values are integers 0–3599 for all six
keys. Interval is 0–15 in canonical 0.1 increments; Rules and client compare to
the rounded tenth divided by 10, avoiding a floating-point remainder check.
Rules tests exercise every one of the 151 valid interval values.

Revision starts at 1 and advances by exactly 1 (safe integer limit). Updates use
`FieldValue.increment(1)` inside the transaction: concurrent rule evaluation
still sees +1, and the read-version precondition triggers an SDK retry on a
conflict. Rules also require server timestamps, immutable createdAt/schema,
and the current identity's device ID. Collection listing, deletion and all
other settings paths remain denied. No Rules are deployed by this block.

Additional real Rules/transaction/subscription tests:

```text
npx firebase emulators:exec --config firebase.member-sync-test.json --project demo-gbf-meron-portal-rules --only firestore "node tests/member-sync.settings.test.cjs && node tests/member-sync.rules.test.cjs"
```

Block 4B must separately connect user edits and validated callbacks to the
calculator, with initial local-data handling and prevention of remote-write loops.
