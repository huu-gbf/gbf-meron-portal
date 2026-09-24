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
  const recruitmentPath = "portalConfig/recruitment";
  const adminUid = "wJRZibao8FgMDqDDQ3csPdVuGkx1";
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

  describe("Recruitment portal config", () => {
    it("allows anyone to read the single recruitment document", async () => {
      await assertSucceeds(testEnv.unauthenticatedContext().firestore().doc(recruitmentPath).get());
      await assertSucceeds(testEnv.authenticatedContext("crew-member").firestore().doc(recruitmentPath).get());
    });

    it("rejects collection listing", async () => {
      await assertFails(testEnv.unauthenticatedContext().firestore().collection("portalConfig").get());
    });

    it("rejects unauthenticated and non-admin writes", async () => {
      const serverTimestamp = require("firebase/firestore").serverTimestamp();
      await assertFails(testEnv.unauthenticatedContext().firestore().doc(recruitmentPath).set({ text: "更新", updatedAt: serverTimestamp }));
      await assertFails(testEnv.authenticatedContext("crew-member").firestore().doc(recruitmentPath).set({ text: "更新", updatedAt: serverTimestamp }));
    });

    it("allows the administrator to create and update valid data", async () => {
      const doc = testEnv.authenticatedContext(adminUid).firestore().doc(recruitmentPath);
      const serverTimestamp = require("firebase/firestore").serverTimestamp();
      await assertSucceeds(doc.set({ text: "管理者による更新", updatedAt: serverTimestamp }));
      await assertSucceeds(doc.set({ text: "再更新", updatedAt: serverTimestamp }));
    });

    it("rejects invalid fields, text values, timestamps, and deletion", async () => {
      const doc = testEnv.authenticatedContext(adminUid).firestore().doc(recruitmentPath);
      const serverTimestamp = require("firebase/firestore").serverTimestamp();
      await assertFails(doc.set({ text: "更新", updatedAt: serverTimestamp, extra: true }));
      await assertFails(doc.set({ text: "", updatedAt: serverTimestamp }));
      await assertFails(doc.set({ text: "a".repeat(10001), updatedAt: serverTimestamp }));
      await assertFails(doc.set({ text: 123, updatedAt: serverTimestamp }));
      await assertFails(doc.set({ text: "更新", updatedAt: new Date(0) }));
      await assertFails(doc.delete());
    });
  });
});
