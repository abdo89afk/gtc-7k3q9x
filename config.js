// Game configuration. Edit this file, nothing else needs to change.
window.GAME_CONFIG = {
  // Paste the Firebase web app config here (Project settings → Your apps → Web).
  // Leave as null to run in local test mode (single browser, no server).
  firebase: {
    apiKey: "AIzaSyAWuOtiv7O3siqpMOucpK6p5vthS0uvLkk",
    authDomain: "guess-the-colleague.firebaseapp.com",
    databaseURL: "https://guess-the-colleague-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "guess-the-colleague",
    appId: "1:982201066219:web:2c775067285b5320c094ae",
  },

  roundSeconds: 20,        // guessing time per photo
  graceMs: 1500,           // answers arriving this long after the timer still count (network lag)
  pointsPerRound: 10,      // points for a fully correct answer
  title: "Guess the Colleague",
};
