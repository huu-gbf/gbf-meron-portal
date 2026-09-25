/* Member identity foundation. Load after Firebase 10 compat app/auth/firestore.
 * No initialization or sign-in occurs until startAuthentication() is called.
 * Profiles, identities and devices are provisioned by the server (Block 3).
 */
(function (root) {
  'use strict';
  const APP_NAME = 'member-sync';

  function createMemberSync(firebase, config) {
    let connection;
    let starting;

    async function startAuthentication() {
      if (starting) return starting;
      starting = (async () => {
        if (!connection) {
          const existing = firebase.apps.find(app => app.name === APP_NAME);
          if (existing && (existing.options.projectId !== config.projectId
              || existing.options.apiKey !== config.apiKey
              || existing.options.appId !== config.appId)) {
            throw new Error('member-sync Firebase configuration mismatch');
          }
          const app = existing || firebase.initializeApp(config, APP_NAME);
          connection = { app, auth: app.auth(), db: app.firestore() };
        }
        const { auth } = connection;
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        // Wait for persisted credentials before deciding to create an account.
        await new Promise((resolve, reject) => {
          let unsubscribe;
          unsubscribe = auth.onAuthStateChanged(() => {
            Promise.resolve().then(() => { unsubscribe(); resolve(); });
          }, error => {
            Promise.resolve().then(() => { unsubscribe(); reject(error); });
          });
        });
        if (!auth.currentUser) await auth.signInAnonymously();
        if (!auth.currentUser?.isAnonymous) {
          throw new Error('member-sync requires its own anonymous authentication');
        }
        return auth.currentUser;
      })();
      try { return await starting; }
      finally { starting = null; }
    }

    async function getIdentity() {
      const user = connection?.auth.currentUser;
      if (!user?.isAnonymous) throw new Error('Start member authentication first');
      // Server read avoids treating a revoked, cached membership as current.
      const snapshot = await connection.db.doc('memberIdentities/' + user.uid)
        .get({ source: 'server' });
      return snapshot.exists ? snapshot.data() : null;
    }

    return Object.freeze({ startAuthentication, getIdentity });
  }

  const api = Object.freeze({ APP_NAME, createMemberSync });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MemberSync = api;
})(globalThis);
