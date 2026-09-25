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

No UI, QR, localStorage integration, settings sync or Block 3B work is included.
