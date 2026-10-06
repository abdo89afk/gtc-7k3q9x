// Two interchangeable backends with the same tiny API:
//   await backend.init()            -> uid
//   backend.on(path, cb)            -> unsubscribe fn; cb(value|null) on every change
//   backend.get(path)               -> Promise<value|null>
//   backend.set(path, value)        -> Promise
//   backend.update(path, patch)     -> Promise  (patch keys may be nested paths "a/b")
//   backend.remove(path)            -> Promise
//   backend.now()                   -> server-adjusted ms
//   backend.TS                      -> server timestamp sentinel
//
// FirebaseBackend talks to Firebase Realtime Database with anonymous auth.
// LocalBackend keeps the tree in localStorage and syncs tabs with BroadcastChannel
// (used for development and automated tests, one browser only).

const TS_SENTINEL = { ".sv": "timestamp" };

class FirebaseBackend {
  constructor(config) {
    this.config = config;
    this.offset = 0;
    this.TS = TS_SENTINEL;
    this.uid = null;
  }
  async init() {
    if (!firebase.apps.length) firebase.initializeApp(this.config);
    this.db = firebase.database();
    this.db.ref(".info/serverTimeOffset").on("value", (s) => { this.offset = s.val() || 0; });
    const auth = firebase.auth();
    if (!auth.currentUser) await auth.signInAnonymously();
    this.uid = auth.currentUser.uid;
    return this.uid;
  }
  on(path, cb) {
    const ref = this.db.ref(path);
    const h = ref.on("value", (s) => cb(s.val()), (err) => console.error("read failed", path, err));
    return () => ref.off("value", h);
  }
  async get(path) { return (await this.db.ref(path).get()).val(); }
  set(path, value) { return this.db.ref(path).set(value); }
  update(path, patch) { return this.db.ref(path).update(patch); }
  remove(path) { return this.db.ref(path).remove(); }
  now() { return Date.now() + this.offset; }
}

class LocalBackend {
  constructor() {
    this.KEY = "gtc-db";
    this.TS = TS_SENTINEL;
    this.subs = [];
    this.uid = null;
    this.chan = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("gtc-db") : null;
    const refresh = () => this._notifyAll();
    if (this.chan) this.chan.onmessage = refresh;
    window.addEventListener("storage", (e) => { if (e.key === this.KEY) refresh(); });
  }
  async init() {
    let uid = sessionStorage.getItem("gtc-uid");
    if (!uid) { uid = "u" + Math.random().toString(36).slice(2, 10); sessionStorage.setItem("gtc-uid", uid); }
    this.uid = uid;
    return uid;
  }
  _tree() { try { return JSON.parse(localStorage.getItem(this.KEY) || "{}"); } catch { return {}; } }
  _save(tree) {
    localStorage.setItem(this.KEY, JSON.stringify(tree));
    if (this.chan) this.chan.postMessage("change");
    this._notifyAll();
  }
  _segs(path) { return String(path).split("/").filter(Boolean); }
  _read(tree, path) {
    let node = tree;
    for (const s of this._segs(path)) { if (node == null || typeof node !== "object" || !(s in node)) return null; node = node[s]; }
    return node === undefined ? null : node;
  }
  _write(tree, path, value) {
    const segs = this._segs(path);
    if (!segs.length) return value == null ? {} : value;
    let node = tree;
    for (let i = 0; i < segs.length - 1; i++) {
      if (node[segs[i]] == null || typeof node[segs[i]] !== "object") node[segs[i]] = {};
      node = node[segs[i]];
    }
    const last = segs[segs.length - 1];
    if (value == null) delete node[last]; else node[last] = value;
    return tree;
  }
  _resolve(value) {
    if (value && typeof value === "object") {
      if (value[".sv"] === "timestamp") return Date.now();
      const out = Array.isArray(value) ? [] : {};
      for (const k in value) { const v = this._resolve(value[k]); if (v !== null && v !== undefined) out[k] = v; }
      return out;
    }
    return value;
  }
  _notifyAll() {
    const tree = this._tree();
    for (const sub of this.subs) {
      const v = this._read(tree, sub.path);
      const j = JSON.stringify(v);
      if (j !== sub.last) { sub.last = j; try { sub.cb(v); } catch (e) { console.error(e); } }
    }
  }
  on(path, cb) {
    const sub = { path, cb, last: undefined };
    this.subs.push(sub);
    const v = this._read(this._tree(), path);
    sub.last = JSON.stringify(v);
    Promise.resolve().then(() => cb(v));
    return () => { this.subs = this.subs.filter((s) => s !== sub); };
  }
  async get(path) { return this._read(this._tree(), path); }
  async set(path, value) { this._save(this._write(this._tree(), path, this._resolve(value))); }
  async update(path, patch) {
    let tree = this._tree();
    for (const k in patch) tree = this._write(tree, path + "/" + k, this._resolve(patch[k]));
    this._save(tree);
  }
  async remove(path) { this._save(this._write(this._tree(), path, null)); }
  now() { return Date.now(); }
}

window.createBackend = function () {
  const cfg = window.GAME_CONFIG || {};
  const forceLocal = new URLSearchParams(location.search).has("local");
  if (cfg.firebase && !forceLocal) return new FirebaseBackend(cfg.firebase);
  return new LocalBackend();
};
