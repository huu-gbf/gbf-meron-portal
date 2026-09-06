const { describe, it, before, after } = require('node:test');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-gbf-meron-portal-rules",
    firestore: {
      rules: fs.readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080
    },
  });
});

after(async () => {
  await testEnv.cleanup();
});

describe("Firestore Security Rules", () => {
  const publicCollections = ["formations_gw", "formations_multi", "formations_high"];
  const internalCollections = [
    "formation_private",
    "formation_push_outbox",
    "notification_tokens",
    "portal_meta",
    "portal_rate_limits",
    "example_private"
  ];

  for (const collection of publicCollections) {
    describe(`Public Collection: ${collection}`, () => {
      before(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await db.collection(collection).doc("testdoc").set({ dummy: "data" });
        });
      });

      it(`A. unauthenticated get が成功`, async () => {
        const unauthedDb = testEnv.unauthenticatedContext().firestore();
        await assertSucceeds(unauthedDb.collection(collection).doc("testdoc").get());
      });

      it(`B. unauthenticated list/query が成功`, async () => {
        const unauthedDb = testEnv.unauthenticatedContext().firestore();
        await assertSucceeds(unauthedDb.collection(collection).get());
      });

      it(`C. create が拒否`, async () => {
        const unauthedDb = testEnv.unauthenticatedContext().firestore();
        await assertFails(unauthedDb.collection(collection).doc("newdoc").set({ dummy: "data" }));
      });

      it(`D. update が拒否`, async () => {
        const unauthedDb = testEnv.unauthenticatedContext().firestore();
        await assertFails(unauthedDb.collection(collection).doc("testdoc").update({ dummy: "newdata" }));
      });

      it(`E. delete が拒否`, async () => {
        const unauthedDb = testEnv.unauthenticatedContext().firestore();
        await assertFails(unauthedDb.collection(collection).doc("testdoc").delete());
      });
    });
  }

  for (const collection of internalCollections) {
    describe(`Internal Collection: ${collection}`, () => {
      before(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await db.collection(collection).doc("testdoc").set({ dummy: "data" });
        });
      });

      it(`F. unauthenticated get/read が拒否`, async () => {
        const unauthedDb = testEnv.unauthenticatedContext().firestore();
        await assertFails(unauthedDb.collection(collection).doc("testdoc").get());
      });

      it(`G. unauthenticated list/query が拒否`, async () => {
        const unauthedDb = testEnv.unauthenticatedContext().firestore();
        await assertFails(unauthedDb.collection(collection).get());
      });

      it(`H. unauthenticated create/write が拒否`, async () => {
        const unauthedDb = testEnv.unauthenticatedContext().firestore();
        await assertFails(unauthedDb.collection(collection).doc("newdoc").set({ dummy: "data" }));
      });

      it(`I. authenticated context でも get/read が拒否`, async () => {
        const authedDb = testEnv.authenticatedContext("testuser").firestore();
        await assertFails(authedDb.collection(collection).doc("testdoc").get());
      });
    });
  }
});
