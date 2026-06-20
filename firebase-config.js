/*
 * Firebase web config for Sky Glider online multiplayer.
 *
 * These values are PUBLIC and safe to commit — access is controlled by the
 * Realtime Database security rules (see database.rules.json), not by hiding
 * these keys. Until you fill them in, the game runs in single-player and the
 * multiplayer layer stays completely dormant (no errors, no network).
 *
 * To enable online play:
 *   1. Create a Firebase project at https://console.firebase.google.com
 *   2. Build → Realtime Database → Create database (any region, locked mode)
 *   3. Authentication → Sign-in method → enable "Anonymous"
 *   4. Project settings → Your apps → add a Web app → copy the config below
 *   5. Paste the values here, commit, and redeploy.
 */
window.FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  databaseURL: "",
  projectId: "",
  appId: "",
};
