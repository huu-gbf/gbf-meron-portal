const { test, before, after } = require('node:test');
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const fs = require('node:fs');

let env;
const bucket = 'gbf-meron-portal.firebasestorage.app';
const path = 'formations/abcdefab-cdef-4abc-8def-abcdefabcdef/01-0123456789abcdef0123456789abcdef.jpg';
const other = 'other/file.jpg';
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-gbf-meron-storage-rules',
    storage: { rules: fs.readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });
  await env.withSecurityRulesDisabled(async context => {
    const storage = context.storage(bucket);
    await storage.ref(path).put(jpeg, { contentType: 'image/jpeg' });
    await storage.ref(other).put(jpeg, { contentType: 'image/jpeg' });
  });
});
after(async () => { await env.cleanup(); });

test('formations: unauthenticated and authenticated clients cannot read, create, update, or delete', async () => {
  for (const context of [env.unauthenticatedContext(), env.authenticatedContext('poster')]) {
    const storage = context.storage(bucket);
    await assertFails(storage.ref(path).getDownloadURL());
    await assertFails(storage.ref(path).put(jpeg, { contentType: 'image/jpeg' }));
    await assertFails(storage.ref(path).delete());
    await assertFails(storage.ref('formations/abcdefab-cdef-4abc-8def-abcdefabcdef/02-0123456789abcdef0123456789abcdef.jpg')
      .put(jpeg, { contentType: 'image/jpeg' }));
  }
});

test('all other paths deny client read and write', async () => {
  for (const context of [env.unauthenticatedContext(), env.authenticatedContext('poster')]) {
    const storage = context.storage(bucket);
    await assertFails(storage.ref(other).getDownloadURL());
    await assertFails(storage.ref(other).put(jpeg, { contentType: 'image/jpeg' }));
    await assertFails(storage.ref(other).delete());
  }
});
