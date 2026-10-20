# Member sync release candidate

This is a development candidate, not a production deployment.

## Fixed sources

- Published main: `75e2876f7092441a85ce2fc28152921d36b39a40`.
- Completed speed / History / Artifact sync: `0d9842e987bb816ca88c9aa90452a5e14681660e`.
- Common ancestor: `e8e411b98c661001d4d55712fb3dcb0ff0e7c822`.
- Production backend protection baseline: main's Dockerfile, main.py and requirements.txt; the prior source audit found no production-only patch.

The merge retains the published feedback form, navigation, latest history and `#sec-feedback`. Rules combine the unchanged feedback block with the unchanged member block. Backend runtime additions are limited to the member mount, `member_sync.py` and its Dockerfile COPY. Dependencies and base image are unchanged.

Approved existing fixes are retained: battle date restoration and speed mobile layout from `adb39bd`, and the 14-column yosen graph from `8f01286`. Yosen tests retain verified historical values and check data/bar/label/column alignment. History tests derive the latest ID independently from the first DOM entry and cover title/date/prepend changes plus local persistence failures.

## Public assets

- `speed-calculator-folder/speed-calculator.html` → `../member-sync.js`, `../member-sync.css`.
- `index.html` → `member-sync.js`.
- `awakening-manager.html` → `artifact-catalog.js`, `member-sync.js`, `artifact-sync.js`.
- These six references use `v=member-sync-rc1`; relative paths and loopback fixture branches remain intact. External Firebase SDK version is unchanged.
- Root `speed-calculator.html`, shared Firebase configuration, Storage Rules and feedback implementation are unchanged.

## Local validation

Use the already installed Node/Python dependencies, Playwright with installed Edge, Java and Firebase CLI. Do not install or upgrade dependencies for this candidate. Block external requests; use loopback fixtures only. Put runner logs and browser artifacts in a dedicated OS TEMP directory and disable Python bytecode / pytest cache writes.

- `node scripts/generate-artifact-rules.cjs --check` (read-only check).
- `node scratch/test_history_unread.js`.
- Run every tracked `tests/*.test.cjs` and `tests/*.test.js` sequentially with `node --test --test-reporter=tap`; fixture/helper files are not suites. Auth/Firestore/Storage hosts are respectively `127.0.0.1:9099`, `127.0.0.1:8080`, `127.0.0.1:9199`.
- Member API and real pairing browser tests require Auth Emulator's default project `gbf-meron-portal` as in `firebase.member-sync-test.json`. A Rules-only demo project's Auth tokens deliberately fail member project validation. Explicit loopback host checks and anonymous emulator credentials are mandatory.
- `npm test` retains its published Firestore/Storage/feedback Rules command. The installed Firebase CLI may be selected through a TEMP runner so emulator/debug logs stay outside the repository; do not change package dependencies.
- Run `tests/test_member_sync_api.py`, `tests/test_member_sync_cors.py` and each root pytest file in separate processes using `python -B -m pytest -q -p no:cacheprovider <file>`.
- Run `test_integration.py`, `test_knowledge_api.py` and `backend/news-watch-job/test_watch_news.py` as scripts, not empty pytest collections.
- `tests/member-sync.release.browser.test.cjs` uses the allowlisted local `member-sync-release-browser.py` fixture to pair PC/mobile, restore the same identities in History/Artifact, preserve default Auth, check portal/feedback navigation and verify release asset URLs. Other browser suites cover offline/reset/pagehide races and feedback CRUD.

## Constraints and later approval

Maximum five devices; no device removal; losing all anonymous credentials prevents automatic recovery. History has a 256-ID limit. Artifact memos remain device-local, concurrent multi-tab editing is unsupported, and its existing mobile overflow of up to 78px is outside this change. Real OS IME/physical-device behavior is not established by automated browser tests.

Before production, separately confirm Pages source/folder, runtime Auth lookup permissions, dedicated HMAC Secret, Anonymous Auth/automatic deletion settings, current backend revision/Rules rollback baselines, and explicit approval for a minimal production smoke test. Keep frontend publication last. Use a fixed-commit clean build context; never upload the working directory's pre-existing untracked files.
