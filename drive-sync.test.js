// Node test for drive-sync.js - no framework, run with:  node drive-sync.test.js
// Two simulated devices (separate vm contexts, each with its own localStorage /
// IndexedDB / unlock state) talk to ONE fake Google Drive. app.js itself is not
// loaded (it needs a full DOM); the few app globals drive-sync.js uses are
// re-created below, with the real merge-engine.js and real AES/PBKDF2 code.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.error('FAIL: ' + name + (detail ? '\n  ' + detail : '')); } }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------- fake Google Drive (one appDataFolder per account) ----------------
function makeDrive() {
  const d = { accounts: {}, clock: Date.UTC(2026, 10, 2), puts: [], deletes: [], counter: 0 };
  d.files = (email) => (d.accounts[email] = d.accounts[email] || new Map());
  d.tick = () => new Date(d.clock += 1000).toISOString();
  d.fetch = async (url, init) => {
    init = init || {};
    const u = new URL(url);
    const auth = (init.headers && init.headers.Authorization) || '';
    const m = /^Bearer tok-(.+)$/.exec(auth);
    const res = (status, body, headers) => ({
      ok: status >= 200 && status < 300, status,
      json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      headers: { get: (k) => (headers || {})[k] || null }
    });
    if (u.hostname === 'upload.mock') { // resumable session PUT
      const files = d.files(d.sessions[u.pathname].email);
      const s = d.sessions[u.pathname];
      const content = await init.body.text();
      return res(200, d.store(files, s.id, s.name, content));
    }
    if (!m) return res(401, 'unauthorized');
    const email = m[1];
    const files = d.files(email);
    const p = u.pathname;
    if (p === '/drive/v3/about') return res(200, { user: { emailAddress: email } });
    if (p === '/drive/v3/files' && (init.method || 'GET') === 'GET') {
      return res(200, { files: [...files.values()].map(f => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, createdTime: f.createdTime })) });
    }
    let mm = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (mm) {
      const f = files.get(mm[1]);
      if ((init.method || 'GET') === 'DELETE') { if (!f) return res(404, 'nf'); files.delete(mm[1]); d.deletes.push(f.name); return res(204, ''); }
      if (!f) return res(404, 'not found');
      if (u.searchParams.get('alt') === 'media') return res(200, f.content);
      return res(200, { modifiedTime: f.modifiedTime });
    }
    mm = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(p);
    if (mm) {
      const type = u.searchParams.get('uploadType');
      if (type === 'resumable') {
        const sid = '/s' + (++d.counter);
        const meta = JSON.parse(init.body);
        d.sessions = d.sessions || {};
        d.sessions[sid] = { email, id: mm[1] || null, name: meta.name };
        return res(200, {}, { Location: 'https://upload.mock' + sid });
      }
      const body = await init.body.text();
      const boundary = /boundary=(.+)$/.exec(init.headers['Content-Type'])[1];
      const parts = body.split('--' + boundary).filter(x => x.trim() && x.trim() !== '--');
      const meta = JSON.parse(parts[0].split('\r\n\r\n')[1].replace(/\r\n$/, ''));
      const content = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
      const name = mm[1] ? files.get(mm[1]).name : meta.name;
      return res(200, d.store(files, mm[1] || null, name, content));
    }
    return res(404, 'no route ' + p);
  };
  d.store = (files, id, name, content) => {
    id = id || 'f' + (++d.counter);
    const prev = files.get(id);
    const f = { id, name, content, createdTime: prev ? prev.createdTime : d.tick(), modifiedTime: d.tick() };
    files.set(id, f);
    d.puts.push(name);
    return { id, name, modifiedTime: f.modifiedTime };
  };
  d.ageFile = (email, name, days) => { for (const f of d.files(email).values()) if (f.name === name) f.modifiedTime = new Date(Date.now() - days * 864e5).toISOString(); };
  return d;
}

// ---------------- one simulated device ----------------
function appSource(name) { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }
function grabFn(src, header) { // exact source of a top-level function from app.js
  const i = src.indexOf(header); if (i < 0) throw new Error('not found: ' + header);
  let j = src.indexOf('{', i), depth = 0;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  return src.slice(i, j + 1);
}
const APP = appSource('app.js');

function makeDevice(drive, opts) {
  const ls = new Map(Object.entries(opts.seed || {})); // localStorage content from "before the page loaded"
  const idb = new Map();
  const els = {};
  const el = (id) => els[id] = els[id] || { id, style: {}, value: '', textContent: '', disabled: false, listeners: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener(t, f) { this.listeners[t] = f; }, focus() {} };
  const dev = { drive, ls, idb, els, conflictQueue: [], renders: 0, email: opts.email, alerts: [] };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, Blob, URL, TextEncoder, TextDecoder, structuredClone,
    crypto: webcrypto, atob, btoa, Promise, Date, Math, JSON, Map, Set, Array, Object, Number, String,
    navigator: { onLine: true }, Uint8Array, ArrayBuffer, addEventListener() {},
    localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
    fetch: (u, i) => drive.fetch(u, i),
    alert: (m) => dev.alerts.push(m), confirm: () => true,
    MutationObserver: class { observe() {} },
    document: {
      getElementById: el, querySelectorAll: () => [], addEventListener() {},
      head: { appendChild(s) { setTimeout(() => s.onload && s.onload(), 0); } }, createElement: () => ({})
    },
    __deviceEmail: () => dev.email,
    __conflictQueue: dev.conflictQueue, __bumpRender: () => dev.renders++, __idb: idb
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  sandbox.google = { accounts: { oauth2: {
    initTokenClient: (c) => ({ requestAccessToken: () => setTimeout(() => c.callback({ access_token: 'tok-' + dev.email, expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.appdata' }), 0) }),
    hasGrantedAllScopes: () => true
  } } };
  const ctx = vm.createContext(sandbox);
  const run = (code, file) => vm.runInContext(code, ctx, { filename: file || 'x.js' });

  run(appSource('merge-engine.js'), 'merge-engine.js');
  run([
    grabFn(APP, 'function bufToB64'), grabFn(APP, 'function b64ToBuf'),
    grabFn(APP, 'async function deriveKeyFromPasscode'), grabFn(APP, 'async function encryptText'), grabFn(APP, 'async function decryptText'),
    `const ENC_PREFIX = 'ENCv1:'; const PBKDF2_ITER_VERSION = 2; const PBKDF2_CONFIGS = { 1: 1000, 2: 1000 };
     const IDB_STORE = 'attachments'; const STORAGE_KEY = 'members';
     let members = []; let membersLoaded = true; let currentMemberId = null; let currentTab = 'overview'; let cryptoKey = null;
     const DEMO_DATA = [{ id: 'demo1', name: 'Dad' }, { id: 'demo2', name: 'Mom' }];
     function getCryptoConfig() { try { return JSON.parse(localStorage.getItem('crypto')); } catch (e) { return null; } }
     function isEncryptionEnabled() { const c = getCryptoConfig(); return !!(c && c.enabled); }
     function isUnlocked() { return !!cryptoKey; }
     async function ensureUnlocked() { return true; }
     function migrateSyncFields(list) { list.forEach(m => { if (!Number.isFinite(m.version)) m.version = 1; }); return list; }
     function intakeCutoffDate() { return '2000-01-01'; }
     function renderMemberList() {} function renderMain() { __bumpRender(); } function updateConflictBadge() {}
     function conflictKey(c) { return JSON.stringify([c.entityId, c.field || null, c.baseVersion]); }
     function appendConflicts(memberId, memberName, list) { let n = 0; const keys = new Set(__conflictQueue.map(conflictKey)); list.forEach(c => { if (keys.has(conflictKey(c))) return; __conflictQueue.push(Object.assign({ memberId, memberName }, c)); n++; }); return n; }
     function saveData() { if (window.FHSDrive) FHSDrive.markDirty(); localStorage.setItem(STORAGE_KEY, JSON.stringify(members)); return true; }
     function idbOpen() { return Promise.resolve({ transaction: () => ({ objectStore: () => ({ getAllKeys: () => { const r = {}; Promise.resolve().then(() => { r.result = [...__idb.keys()]; r.onsuccess(); }); return r; } }) }) }); }
     async function idbPut(id, dataUrl) { __idb.set(id, await encryptText(dataUrl, cryptoKey)); }
     async function idbGet(id) { const v = __idb.get(id); return v === undefined ? undefined : decryptText(v, cryptoKey); }
     async function __setupPasscode(pass) { const salt = bufToB64(crypto.getRandomValues(new Uint8Array(16))); const key = await deriveKeyFromPasscode(pass, salt, 1000); const verifier = await encryptText('verify-ok', key); localStorage.setItem('crypto', JSON.stringify({ enabled: true, salt, verifier, iterVer: 2 })); cryptoKey = key; if (window.FHSDrive) FHSDrive.onPasscode(pass); }
     async function __unlock(pass) { const c = getCryptoConfig(); cryptoKey = await deriveKeyFromPasscode(pass, c.salt, 1000); if (window.FHSDrive) FHSDrive.onPasscode(pass); }
     function __lock() { cryptoKey = null; if (window.FHSDrive) FHSDrive.onLock(); }
     function __setMembers(m) { members = m; } function __getMembers() { return members; }
     function __setCurrent(id) { currentMemberId = id; } function __getCurrent() { return currentMemberId; }`
  ].join('\n'), 'prelude.js');
  run(appSource('drive-sync.js'), 'drive-sync.js');

  // ids used by the Settings UI must exist before drive-sync.js binds them
  dev.run = run;
  dev.setPasscode = (p) => run(`__setupPasscode(${JSON.stringify(p)})`);
  dev.unlock = (p) => run(`__unlock(${JSON.stringify(p)})`);
  dev.lock = () => run('__lock()');
  dev.setMembers = (m) => { run('__setMembers(' + JSON.stringify(m) + ')'); };
  dev.members = () => JSON.parse(JSON.stringify(run('__getMembers()')));
  dev.save = () => run('saveData()');
  dev.edit = (fn) => { const m = run('__getMembers()'); fn(m); dev.save(); };
  dev.state = () => run('FHSDrive._state()');
  dev.sync = (o) => run('FHSDrive.syncNow(' + JSON.stringify(o || {}) + ')');
  dev.putAtt = (id, dataUrl) => run(`idbPut(${JSON.stringify(id)}, ${JSON.stringify(dataUrl)})`);
  dev.getAtt = (id) => run(`idbGet(${JSON.stringify(id)})`);
  dev.click = (id) => els[id].listeners.click();
  dev.el = el;
  return dev;
}

// ---------------- fixtures ----------------
const T0 = '2026-11-01T00:00:00.000Z';
const mkRecord = (id, title, atts) => ({ id, type: 'Checkup', title, date: '2026-11-01', version: 1, updatedAt: T0, deletedAt: null, schemaVersion: 1, attachments: atts || [] });
const mkMember = (id, name, records) => ({ id, name, version: 1, updatedAt: T0, deletedAt: null, schemaVersion: 1, fieldVersion: null, records: records || [], customReminders: [], historyEntries: [], bloodTypeAttachment: null, gender: 'Male', birth: '', blood: 'A', height: 170, allergies: 'None', history: '', emergency: '', nameZh: '' });
const fv = (m) => { m.fieldVersion = Object.fromEntries(Object.keys(require('./merge-engine.js').freshFieldVersions()).map(k => [k, 1])); return m; };
const att = (id, name) => ({ id, name: name || id + '.jpg', type: 'image', thumb: 'data:image/png;base64,AAAA', size: 10, deletedAt: null });
const PASS = 'correct horse';

(async () => {
  // ===== 1. first device connects: nothing in Drive yet =====
  const drive = makeDrive();
  const A = makeDevice(drive, { email: 'me@example.com' });
  await A.setPasscode(PASS);
  A.setMembers([fv(mkMember('m1', 'Dad', [mkRecord('r1', 'Checkup 2026', [att('att1')])]))]);
  await A.putAtt('att1', 'data:image/jpeg;base64,PHOTO-BYTES-1');

  await A.click('btnDriveConnect');           // opens dialog (step 1; the field is cleared on open)
  await wait(20);
  A.el('drivePasscodeInput').value = PASS;
  await A.click('btnDriveConnectGo');         // passcode check
  await wait(50);
  ok('connect step 1 accepted passcode', A.el('driveConnectError').textContent === '', A.el('driveConnectError').textContent);
  await A.click('btnDriveConnectGo');         // sign-in + first sync
  await wait(300);
  ok('A is connected', A.state().cfg.connected === true);
  ok('A knows its Google account', A.state().cfg.email === 'me@example.com');
  const names1 = [...drive.files('me@example.com').values()].map(f => f.name).sort();
  ok('Drive holds sync file + 1 attachment file', JSON.stringify(names1) === JSON.stringify(['my-health-att-att1.json', 'my-health-sync.json']), names1.join());
  const blob = [...drive.files('me@example.com').values()].map(f => f.content).join('');
  ok('nothing readable in Drive (encrypted)', !/Dad|Checkup|PHOTO-BYTES/.test(blob));
  ok('A status ok', A.state().status.state === 'ok', JSON.stringify(A.state().status));
  ok('header badge shows "Synced <time>"', /^☁️ Synced /.test(A.el('driveSyncBadge').textContent) && A.el('driveSyncBadge').hidden === false, A.el('driveSyncBadge').textContent);

  // ===== 2. second device (only sample data) connects with the same passcode =====
  const B = makeDevice(drive, { email: 'me@example.com' });
  await B.setPasscode(PASS);
  B.setMembers([{ id: 'demo1', name: 'Dad' }, { id: 'demo2', name: 'Mom' }]);
  await B.click('btnDriveConnect'); await wait(20);
  B.el('drivePasscodeInput').value = PASS;
  await B.click('btnDriveConnectGo'); await wait(50);
  await B.click('btnDriveConnectGo'); await wait(400);
  ok('B adopted the Drive data (sample data replaced)', JSON.stringify(B.members().map(m => m.id)) === '["m1"]', JSON.stringify(B.members().map(m => m.id)));
  ok('B downloaded the attachment bytes under the SAME id', (await B.getAtt('att1')) === 'data:image/jpeg;base64,PHOTO-BYTES-1');
  ok('B did not re-upload anything', drive.puts.length === 2, drive.puts.join());

  // ===== 3. wrong passcode on a third device is refused =====
  const C = makeDevice(drive, { email: 'me@example.com' });
  await C.setPasscode('another passcode');
  C.setMembers([]);
  await C.click('btnDriveConnect'); await wait(20);
  C.el('drivePasscodeInput').value = 'another passcode';
  await C.click('btnDriveConnectGo'); await wait(50);
  const confirmCalls = [];
  C.run('confirm = (m) => { __conf.push(m); return false; }'.replace('__conf', 'globalThis.__conf = globalThis.__conf || []; __conf'));
  await C.click('btnDriveConnectGo'); await wait(400);
  ok('C (different passcode) is NOT connected when it declines to overwrite Drive', !C.state().cfg.connected);
  ok('Drive data untouched by C', drive.files('me@example.com').size === 2);

  // ===== 4. an edit on B reaches A (merge, no overwrite) =====
  const putsBefore = drive.puts.length;
  B.edit((ms) => {
    const r = ms[0].records[0]; r.title = 'Checkup (edited on B)'; r.version++; r.updatedAt = new Date().toISOString();
    ms[0].records.push(mkRecord('r2', 'New record from B', [att('att2')]));
  });
  await B.putAtt('att2', 'data:image/jpeg;base64,PHOTO-BYTES-2');
  await wait(20);
  await B.sync();                                  // (the 4 s debounce would do this)
  ok('B pushed 1 attachment + the data', drive.puts.slice(putsBefore).sort().join() === 'my-health-att-att2.json,my-health-sync.json', drive.puts.slice(putsBefore).join());
  await A.sync({ force: true });
  const aRecs = A.members()[0].records;
  ok('A got B\'s edit and new record', aRecs.length === 2 && aRecs[0].title === 'Checkup (edited on B)');
  ok('A got B\'s new attachment bytes', (await A.getAtt('att2')) === 'data:image/jpeg;base64,PHOTO-BYTES-2');
  ok('A re-rendered', A.renders > 0);

  // ===== 5. nothing changed -> nothing uploaded (no ping-pong) =====
  const p5 = drive.puts.length;
  await A.sync(); await B.sync(); await A.sync(); await B.sync();
  ok('idle syncs upload nothing', drive.puts.length === p5, drive.puts.slice(p5).join());

  // ===== 6. same thing edited on both devices -> conflict queue, nothing lost, settles =====
  A.edit((ms) => { const r = ms[0].records[0]; r.title = 'A says one'; r.version++; r.updatedAt = new Date().toISOString(); });
  B.edit((ms) => { const r = ms[0].records[0]; r.title = 'B says two'; r.version++; r.updatedAt = new Date().toISOString(); });
  await A.sync();
  await B.sync();
  ok('B queued a conflict', B.conflictQueue.length >= 1, 'queue=' + B.conflictQueue.length);
  ok('B kept its own version meanwhile', B.members()[0].records[0].title === 'B says two');
  const p6 = drive.puts.length;
  for (let i = 0; i < 6; i++) { await A.sync(); await B.sync(); }
  ok('unresolved conflict settles instead of overwriting each other for ever', drive.puts.length - p6 <= 3, 'extra uploads: ' + (drive.puts.length - p6));
  const aKeep = A.members()[0].records[0].title, bKeep = B.members()[0].records[0].title;
  ok('both versions still exist somewhere (nothing lost)', [aKeep, bKeep].includes('A says one') && [aKeep, bKeep].includes('B says two') || A.conflictQueue.length + B.conflictQueue.length > 0);

  // ===== 7. a deletion on A (tombstone) reaches B =====
  A.edit((ms) => { const r = ms[0].records[1]; r.deletedAt = new Date().toISOString(); r.version++; r.updatedAt = new Date().toISOString(); });
  await A.sync(); await B.sync({ force: true });
  ok('B received the deletion', !!B.members()[0].records[1].deletedAt);

  // ===== 8. old unreferenced attachment files are cleaned up, young ones are not =====
  drive.ageFile('me@example.com', 'my-health-att-att2.json', 40);
  await A.sync({ force: true });
  ok('40-day-old orphan attachment file removed from Drive', drive.deletes.includes('my-health-att-att2.json'), drive.deletes.join());
  ok('live attachment file kept', [...drive.files('me@example.com').values()].some(f => f.name === 'my-health-att-att1.json'));

  // ===== 9. locked app does not sync; unlocking resumes =====
  A.lock();
  const p9 = drive.puts.length;
  A.edit((ms) => { ms[0].records[0].notes = 'edited while locked'; ms[0].records[0].version++; });
  await A.sync();
  ok('locked: no upload, status says so', drive.puts.length === p9 && A.state().status.state === 'locked', A.state().status.state);
  await A.unlock(PASS); await wait(900);
  ok('after unlock the pending edit goes up', drive.puts.length > p9);

  // ===== 10. a device connected as me@example.com must refuse a token for another Google account =====
  const cfgJson = JSON.stringify({ connected: true, salt: A.state().cfg.salt, iterVer: 2, email: 'me@example.com', lastRemoteModified: '', lastSyncHash: '' });
  const W = makeDevice(drive, { email: 'other@example.com', seed: { family_health_tracker_v3_drive: cfgJson } });
  await W.setPasscode(PASS); // (re-derives the sync key from the seeded salt)
  W.setMembers([fv(mkMember('w1', 'Stranger'))]);
  const before10 = drive.files('other@example.com').size;
  await W.sync({ interactive: true }); await wait(50);
  ok('wrong Google account: sync refused', W.state().status.state === 'auth', JSON.stringify(W.state().status));
  ok('wrong Google account: badge warns', /Sign in to sync/.test(W.el('driveSyncBadge').textContent), W.el('driveSyncBadge').textContent);
  ok('wrong Google account: nothing written to that account', drive.files('other@example.com').size === before10);

  // ===== 11. disconnect (and delete the Drive copy) =====
  await A.unlock(PASS).catch(() => {});
  await A.click('btnDriveDisconnect'); await wait(200);
  ok('disconnect clears the connection', !A.state().cfg.connected);
  ok('header badge is hidden again after disconnect', A.el('driveSyncBadge').hidden === true);
  ok('disconnect + delete emptied the Drive copy', drive.files('me@example.com').size === 0, 'left: ' + [...drive.files('me@example.com').values()].map(f => f.name).join());

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
