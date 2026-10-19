const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, beforeEach, describe, test } = require('node:test');
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  setLogLevel,
  Timestamp,
  updateDoc,
} = require('firebase/firestore');

const root = path.resolve(__dirname, '..');
const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
const projectId = 'demo-feedback-mvp-rules';
const adminUid = 'wJRZibao8FgMDqDDQ3csPdVuGkx1';
const canonicalLf = (value) => value.replace(/\r\n/g, '\n');
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

test('existing Firestore rules and Storage rules retain their baseline contents', () => {
  // Baseline: main e8e411b. Allow checkout line-ending differences only.
  const begin = '    // Portal feedback MVP: BEGIN\n';
  const end = '    // Portal feedback MVP: END\n';
  const current = canonicalLf(rules);
  assert.equal(current.split(begin).length, 2, 'one feedback block begins');
  assert.equal(current.split(end).length, 2, 'one feedback block ends');
  const start = current.indexOf(begin);
  const finish = current.indexOf(end) + end.length;
  assert.ok(finish > start);
  const original = current.slice(0, start) + current.slice(finish);
  assert.equal(sha256(original), '64f8595704ddf2ee0d2e2ca2bfce44820ce4e44480b4ca2d4d4f7fb92a351d17');
  assert.equal(
    sha256(canonicalLf(fs.readFileSync(path.join(root, 'storage.rules'), 'utf8'))),
    '5223bdd146fead827cce89f6bbf0d9cbb836d8b815ca30c1192faff34351b507',
  );
  assert.match(original, /match \/\{document=\*\*\} \{\n      allow read, write: if false;\n    \}/);
});

describe('portalFeedback rules on an isolated local demo project', { concurrency: false }, () => {
  let env;
  let databases;
  let nextId = 0;

  const valid = (overrides = {}) => ({
    schemaVersion: 1,
    type: 'bug',
    message: '表示が崩れています。\n再現手順\tスマートフォンで開く',
    name: '',
    target: '',
    createdAt: serverTimestamp(),
    ...overrides,
  });
  const freshReport = (db) => doc(db, 'portalFeedback', `report-${++nextId}`);
  const create = (db, overrides = {}) => setDoc(freshReport(db), valid(overrides));

  async function rejectCreate(overrides, label = 'invalid feedback') {
    try {
      await assertFails(create(databases.visitor, overrides));
    } catch (cause) {
      throw new Error(label, { cause });
    }
  }

  async function seed(documentPath, value) {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), documentPath), value);
    });
  }

  before(async () => {
    assert.equal(
      process.env.FIRESTORE_EMULATOR_HOST,
      '127.0.0.1:8080',
      'Run only against the explicitly selected local Firestore emulator',
    );
    assert.match(projectId, /^demo-/, 'Rules tests must never use a production project');
    setLogLevel('silent');
    env = await initializeTestEnvironment({
      projectId,
      firestore: { host: '127.0.0.1', port: 8080, rules },
    });
    databases = {
      visitor: env.unauthenticatedContext().firestore(),
      member: env.authenticatedContext('feedback-member').firestore(),
      admin: env.authenticatedContext(adminUid).firestore(),
    };
  });

  beforeEach(async () => {
    await env.clearFirestore();
  });

  after(async () => {
    if (env) await env.cleanup();
  });

  test('accepts all three categories from visitors, other users, and the administrator', async () => {
    for (const db of Object.values(databases)) {
      for (const type of ['bug', 'request', 'other']) {
        await assertSucceeds(create(db, { type }));
      }
    }
  });

  test('accepts empty optional strings and keeps the six-field document shape', async () => {
    const reference = freshReport(databases.visitor);
    await assertSucceeds(setDoc(reference, valid()));
    const stored = await assertSucceeds(getDoc(doc(databases.admin, reference.path)));
    assert.deepEqual(Object.keys(stored.data()).sort(), [
      'createdAt', 'message', 'name', 'schemaVersion', 'target', 'type',
    ]);
    assert.equal(stored.data().name, '');
    assert.equal(stored.data().target, '');
    assert.ok(stored.data().createdAt instanceof Timestamp);
  });

  test('requires every field and rejects additional fields', async () => {
    for (const field of Object.keys(valid())) {
      const incomplete = valid();
      delete incomplete[field];
      await assertFails(setDoc(freshReport(databases.visitor), incomplete));
    }
    for (const field of ['uid', 'status', 'admin', 'extra']) {
      await rejectCreate({ [field]: 'unexpected' }, `unexpected field ${field}`);
    }
  });

  test('requires schema version integer 1 and an exact category', async () => {
    for (const schemaVersion of [0, 2, 1.5, '1', null, true, {}, []]) {
      await rejectCreate({ schemaVersion }, `schemaVersion ${JSON.stringify(schemaVersion)}`);
    }
    for (const type of ['', 'BUG', 'feedback', 1, null, true, {}, []]) {
      await rejectCreate({ type }, `type ${JSON.stringify(type)}`);
    }
  });

  test('requires string text fields and a server timestamp equal to request.time', async () => {
    for (const field of ['message', 'name', 'target']) {
      for (const value of [null, 1, true, {}, []]) {
        await rejectCreate({ [field]: value }, `${field} ${JSON.stringify(value)}`);
      }
    }
    for (const createdAt of [null, 1, true, '', {}, [], new Date(0), Timestamp.fromMillis(0)]) {
      await rejectCreate({ createdAt }, 'non-server createdAt');
    }
  });

  test('rejects empty text and every whitespace-only string removed by JavaScript trim', async () => {
    const trimWhitespace = [
      '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\u1680',
      '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007',
      '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
    ];
    await rejectCreate({ message: '' }, 'empty message');
    for (const character of trimWhitespace) {
      assert.equal(character.trim(), '');
      await rejectCreate({ message: character.repeat(3) }, `whitespace U+${character.codePointAt(0).toString(16)}`);
    }
    await rejectCreate({ message: trimWhitespace.join('') }, 'mixed Unicode whitespace');
    for (const retainedCharacter of ['\u180e', '\u200b', '\u2060']) {
      assert.notEqual(retainedCharacter.trim(), '');
      await assertSucceeds(create(databases.visitor, { message: retainedCharacter }));
    }
    await assertSucceeds(create(databases.visitor, { message: ' \u00a0内容\u3000 ' }));
  });

  test('counts message length in Unicode code points for Japanese and emoji', async () => {
    for (const character of ['あ', '😀']) {
      for (const length of [1, 1000, 1001, 3999, 4000]) {
        await assertSucceeds(create(databases.visitor, { message: character.repeat(length) }));
      }
      await rejectCreate({ message: character.repeat(4001) }, `4001 ${character}`);
    }
    await assertSucceeds(create(databases.visitor, { message: `${'😀'.repeat(3999)}\n` }));
    await rejectCreate({ message: `${'😀'.repeat(4000)}\n` }, '4001 including LF');
  });

  test('counts optional names and targets in Unicode code points', async () => {
    for (const character of ['団', '😀']) {
      await assertSucceeds(create(databases.visitor, {
        name: character.repeat(40), target: character.repeat(100),
      }));
      await rejectCreate({ name: character.repeat(41) }, `41-character name ${character}`);
      await rejectCreate({ target: character.repeat(101) }, `101-character target ${character}`);
    }
  });

  test('permits LF and TAB in messages and rejects every other C0/C1 control character', async () => {
    await assertSucceeds(create(databases.visitor, { message: '本文\n次の行\t補足' }));
    const controls = [
      ...Array.from({ length: 32 }, (_, index) => index),
      ...Array.from({ length: 33 }, (_, index) => 0x7f + index),
    ];
    for (const code of controls.filter((value) => value !== 0x09 && value !== 0x0a)) {
      await rejectCreate({ message: `本文${String.fromCodePoint(code)}補足` }, `message control U+${code.toString(16)}`);
    }
    await rejectCreate({ message: '本文\r\n次の行' }, 'CRLF must be normalized before submission');
  });

  test('rejects line separators and unnecessary controls in names and targets', async () => {
    const forbidden = [
      '\u0000', '\u0008', '\n', '\u000b', '\u000c', '\r', '\u001f',
      '\u007f', '\u0085', '\u009f', '\u2028', '\u2029',
    ];
    for (const field of ['name', 'target']) {
      await assertSucceeds(create(databases.visitor, { [field]: '項目\t補足' }));
      for (const character of forbidden) {
        await rejectCreate({ [field]: `項目${character}補足` }, `${field} control U+${character.codePointAt(0).toString(16)}`);
      }
    }
  });

  test('allows only the designated administrator to get, list, and delete feedback', async () => {
    const reportPath = 'portalFeedback/private-report';
    await seed(reportPath, { ...valid(), createdAt: Timestamp.fromMillis(0) });
    for (const db of [databases.visitor, databases.member]) {
      await assertFails(getDoc(doc(db, reportPath)));
      await assertFails(getDocs(collection(db, 'portalFeedback')));
      await assertFails(deleteDoc(doc(db, reportPath)));
    }
    await assertSucceeds(getDoc(doc(databases.admin, reportPath)));
    const listed = await assertSucceeds(getDocs(collection(databases.admin, 'portalFeedback')));
    assert.equal(listed.size, 1);
    await assertSucceeds(deleteDoc(doc(databases.admin, reportPath)));
    assert.equal((await getDoc(doc(databases.admin, reportPath))).exists(), false);
  });

  test('rejects updates, merges, and full overwrites from every caller', async () => {
    const reportPath = 'portalFeedback/immutable-report';
    await seed(reportPath, { ...valid(), createdAt: Timestamp.fromMillis(0) });
    for (const db of Object.values(databases)) {
      const reference = doc(db, reportPath);
      await assertFails(updateDoc(reference, { message: '書き換え' }));
      await assertFails(setDoc(reference, { message: 'マージ' }, { merge: true }));
      await assertFails(setDoc(reference, valid({ message: '全体を上書き' })));
    }
    assert.equal((await getDoc(doc(databases.admin, reportPath))).data().message, valid().message);
  });

  test('denies feedback subcollections and similarly named collection paths', async () => {
    const nestedPath = 'portalFeedback/report/notes/private';
    await seed(nestedPath, { secret: true });
    for (const db of Object.values(databases)) {
      await assertFails(getDoc(doc(db, nestedPath)));
      await assertFails(getDocs(collection(db, 'portalFeedback/report/notes')));
      await assertFails(setDoc(doc(db, nestedPath), valid()));
      await assertFails(deleteDoc(doc(db, nestedPath)));
      await assertFails(setDoc(doc(db, 'portalFeedbackOther/report'), valid()));
    }
  });

  test('retains public formation reads and denies all formation writes', async () => {
    for (const collectionName of ['formations_gw', 'formations_multi', 'formations_high']) {
      await seed(`${collectionName}/existing`, { dummy: 'public' });
      for (const db of Object.values(databases)) {
        await assertSucceeds(getDoc(doc(db, collectionName, 'existing')));
        await assertSucceeds(getDocs(collection(db, collectionName)));
        await assertFails(setDoc(doc(db, collectionName, 'new'), { dummy: 'write' }));
        await assertFails(updateDoc(doc(db, collectionName, 'existing'), { dummy: 'update' }));
        await assertFails(deleteDoc(doc(db, collectionName, 'existing')));
      }
    }
  });

  test('retains recruitment public get and administrator-only editing', async () => {
    const recruitmentPath = 'portalConfig/recruitment';
    const value = () => ({ text: '募集文', updatedAt: serverTimestamp() });
    for (const db of Object.values(databases)) {
      await assertSucceeds(getDoc(doc(db, recruitmentPath)));
      await assertFails(getDocs(collection(db, 'portalConfig')));
    }
    for (const db of [databases.visitor, databases.member]) {
      await assertFails(setDoc(doc(db, recruitmentPath), value()));
    }
    await assertSucceeds(setDoc(doc(databases.admin, recruitmentPath), value()));
    await assertSucceeds(setDoc(doc(databases.admin, recruitmentPath), value()));
    await assertFails(deleteDoc(doc(databases.admin, recruitmentPath)));
  });

  test('retains shared predictor public get and administrator-only editing', async () => {
    const predictorPath = 'publicTools/yosenPredictor';
    const value = () => ({
      schemaVersion: 1, eventDate: '2026-09-17', dayType: 'weekday',
      score12: 100000000000, score18: 160000000000, score20: null,
      updatedAt: serverTimestamp(),
    });
    for (const db of Object.values(databases)) {
      await assertSucceeds(getDoc(doc(db, predictorPath)));
      await assertFails(getDocs(collection(db, 'publicTools')));
    }
    for (const db of [databases.visitor, databases.member]) {
      await assertFails(setDoc(doc(db, predictorPath), value()));
    }
    await assertSucceeds(setDoc(doc(databases.admin, predictorPath), value()));
    await assertSucceeds(setDoc(doc(databases.admin, predictorPath), value()));
    await assertFails(deleteDoc(doc(databases.admin, predictorPath)));
  });

  test('retains battle review public reads and administrator-only writes', async () => {
    const session = '2026-09-17_day1';
    const metaPath = `gwBattleReviews/${session}/entries/meta`;
    const entryPath = `gwBattleReviews/${session}/entries/0700`;
    const meta = () => ({
      schemaVersion: 1, dateJst: '2026-09-17', dayKey: 'day1', dayType: 'weekday',
      base: null, migrationId: 'feedback-permission-regression', updatedAt: serverTimestamp(),
    });
    const entry = () => ({ time: '07:00', own: 100, enemy: 200, updatedAt: serverTimestamp() });
    for (const db of Object.values(databases)) {
      await assertSucceeds(getDoc(doc(db, metaPath)));
      await assertSucceeds(getDocs(collection(db, `gwBattleReviews/${session}/entries`)));
    }
    for (const db of [databases.visitor, databases.member]) {
      await assertFails(setDoc(doc(db, metaPath), meta()));
    }
    await assertSucceeds(setDoc(doc(databases.admin, metaPath), meta()));
    await assertSucceeds(setDoc(doc(databases.admin, entryPath), entry()));
    for (const db of [databases.visitor, databases.member]) {
      await assertFails(setDoc(doc(db, entryPath), entry()));
      await assertFails(deleteDoc(doc(db, entryPath)));
    }
    await assertFails(deleteDoc(doc(databases.admin, metaPath)));
    await assertSucceeds(deleteDoc(doc(databases.admin, entryPath)));
  });

  test('keeps existing internal collections and every unmatched path denied', async () => {
    const privateCollections = [
      'formation_private', 'formation_push_outbox', 'notification_tokens',
      'portal_meta', 'portal_rate_limits', 'example_private',
    ];
    for (const collectionName of privateCollections) {
      await seed(`${collectionName}/existing`, { secret: true });
      for (const db of Object.values(databases)) {
        await assertFails(getDoc(doc(db, collectionName, 'existing')));
        await assertFails(getDocs(collection(db, collectionName)));
        await assertFails(setDoc(doc(db, collectionName, 'new'), { secret: true }));
        await assertFails(deleteDoc(doc(db, collectionName, 'existing')));
      }
    }
  });
});
