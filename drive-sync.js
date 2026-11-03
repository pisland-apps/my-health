// ========== GOOGLE DRIVE SYNC (v73) ==========
// Optional sync of the whole family between devices through the person's OWN
// Google Drive. Loaded after app.js as a classic script, so it shares app.js's
// top-level bindings (members, cryptoKey helpers, saveData, FHSMerge ...).
//
// What goes to Drive (hidden "appDataFolder", scope drive.appdata ONLY - the
// app cannot see or touch any other file in the person's Drive):
//   my-health-sync.json        the member data, encrypted
//   my-health-att-<id>.json    one encrypted file per photo / PDF attachment
// Everything is encrypted on this device BEFORE upload with AES-256-GCM. The
// key is PBKDF2(passcode, driveSalt). driveSalt is generated once, lives in the
// sync file and is copied into this device's drive config, so every device that
// uses the same passcode derives the same key. The key only exists in memory
// while the app is unlocked (it is derived inside cryptoSetup/cryptoUnlock,
// which is the only place the plaintext passcode is ever available).
//
// Sync is a MERGE, never an overwrite: pull -> FHSMerge.mergeMembers ->
// push. Edits made on two devices for the same thing end up in the existing
// Conflicts queue (nothing is lost), deletions travel as tombstones.
(function () {
  'use strict';

  const CLIENT_ID = '951288511412-ov1690en8484rbae7m7vg2rn40mk47hj.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const CFG_KEY = 'family_health_tracker_v3_drive'; // "family_health_tracker" prefix => wiped by "Reset app data"
  const SYNC_FILE = 'my-health-sync.json';
  const ATT_PREFIX = 'my-health-att-';
  const ATT_SUFFIX = '.json';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const DEBOUNCE_MS = 4000;          // after an edit
  const POLL_MS = 5 * 60 * 1000;     // pull other devices' changes while the app is open
  const MULTIPART_MAX = 4 * 1024 * 1024; // above this, use a resumable upload
  const ORPHAN_DAYS = 30;            // unreferenced attachment files are deleted after this long
  const NOT_BLOCKING_MODALS = ['settingsModal', 'driveConnectModal'];

  // ---------- persisted config (no tokens, no keys) ----------
  function loadCfg() { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) { return {}; } }
  let cfg = loadCfg(); // { connected, salt, iterVer, email, lastSyncAt, lastRemoteModified, lastSyncHash, lastError }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* storage full: sync state is re-derivable */ } }

  // ---------- in-memory state ----------
  let syncKey = null;            // CryptoKey, only while unlocked
  let keyPromise = Promise.resolve(null);
  let token = null;              // { value, exp }
  let tokenClient = null, pendingReq = null, gisPromise = null, accountChecked = false;
  let running = false, rerun = null, timer = null, applying = false;
  let status = { state: 'off', text: '' };

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  function authError(msg) { const e = new Error(msg); e.auth = true; return e; }
  function stable(v) { // key-order independent JSON, used to compare / hash member data
    if (v === undefined) return 'null';
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined)
        .map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  }
  function hashStr(s) { // cyrb53
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  function withTimeout(p, ms, msg) {
    let t;
    return Promise.race([
      p,
      new Promise((_, rej) => { t = setTimeout(() => rej(authError(msg)), ms); })
    ]).finally(() => clearTimeout(t));
  }
  function describe(e) {
    if (!e) return 'Unknown error';
    if (e.type === 'popup_closed') return 'The Google sign-in window was closed.';
    if (e.type === 'popup_failed_to_open') return 'The browser blocked the Google sign-in window. Allow pop-ups for this site and try again.';
    return e.message || e.type || String(e);
  }
  function timeAgo(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  // ---------- Google sign-in (token client, loaded only when needed) ----------
  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in. Check your connection.')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }
  function ensureTokenClient() {
    if (tokenClient) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => { const p = pendingReq; pendingReq = null; if (p) p.resolve(resp); },
      error_callback: (err) => { const p = pendingReq; pendingReq = null; if (p) p.reject(authError(describe(err))); }
    });
  }
  // prompt: 'select_account' (first connect, lets the person pick the Drive
  // account), '' (re-consent if needed) or 'none' (silent, background use).
  function requestToken(prompt) {
    return new Promise((resolve, reject) => {
      pendingReq = { resolve, reject };
      const o = { prompt };
      if (cfg.email && prompt !== 'select_account') o.hint = cfg.email; // keep using the SAME Google account
      try { tokenClient.requestAccessToken(o); } catch (e) { pendingReq = null; reject(authError(describe(e))); }
    }).then((resp) => {
      if (!resp || resp.error || !resp.access_token) throw authError((resp && (resp.error_description || resp.error)) || 'Google sign-in failed.');
      if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
        throw authError('Google Drive permission was not granted.');
      }
      token = { value: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 60000 };
      return token.value;
    });
  }
  async function getToken(interactive, prompt) {
    if (token && token.exp > Date.now()) return token.value;
    await loadGis();
    ensureTokenClient();
    try {
      return await (interactive
        ? withTimeout(requestToken(prompt === undefined ? '' : prompt), 180000, 'Google sign-in timed out.')
        : withTimeout(requestToken('none'), 15000, 'Google needs you to sign in again.'));
    } catch (e) { throw e && e.auth ? e : authError(describe(e)); }
  }

  // ---------- Drive REST helpers ----------
  async function dfetch(url, init, interactive) {
    init = init || {};
    const send = async () => {
      const tk = await getToken(!!interactive);
      return fetch(url, Object.assign({}, init, { headers: Object.assign({}, init.headers, { Authorization: 'Bearer ' + tk }) }));
    };
    let res = await send();
    if (res.status === 401) { token = null; res = await send(); }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error('Google Drive error ' + res.status + (body ? ': ' + body.slice(0, 160) : ''));
      err.status = res.status;
      throw err;
    }
    return res;
  }
  async function listFiles(interactive) {
    const out = [];
    let pageToken = '';
    do {
      const url = API + '/files?spaces=appDataFolder&pageSize=1000&fields=' +
        encodeURIComponent('nextPageToken,files(id,name,modifiedTime,createdTime)') +
        (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      const j = await (await dfetch(url, {}, interactive)).json();
      out.push.apply(out, j.files || []);
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  }
  async function downloadText(id) { return (await dfetch(API + '/files/' + id + '?alt=media')).text(); }
  async function deleteFile(id) {
    try { await dfetch(API + '/files/' + id, { method: 'DELETE' }); }
    catch (e) { if (e.status !== 404) throw e; }
  }
  async function uploadFile(name, existingId, text) {
    const meta = existingId ? {} : { name: name, parents: ['appDataFolder'] };
    const fields = '&fields=id,name,modifiedTime';
    const method = existingId ? 'PATCH' : 'POST';
    const base = existingId ? UPLOAD + '/' + existingId : UPLOAD;
    const size = new Blob([text]).size;
    if (size <= MULTIPART_MAX) {
      const boundary = 'fhs' + Math.random().toString(36).slice(2);
      const body = new Blob([
        '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
        '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n',
        text,
        '\r\n--' + boundary + '--'
      ]);
      const res = await dfetch(base + '?uploadType=multipart' + fields, {
        method: method,
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
        body: body
      });
      return res.json();
    }
    // Large attachment: resumable session, whole file in one PUT.
    const init = await dfetch(base + '?uploadType=resumable' + fields, {
      method: method,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/json' },
      body: JSON.stringify(meta)
    });
    const loc = init.headers.get('Location');
    if (!loc) throw new Error('Google Drive did not start the upload.');
    const put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: new Blob([text]) });
    if (!put.ok) { const e = new Error('Google Drive upload failed (' + put.status + ').'); e.status = put.status; throw e; }
    return put.json();
  }
  // The person may have several Google accounts in this browser: make sure the
  // token we got belongs to the account this device was connected with.
  async function checkAccount(interactive, skipCompare) {
    let email = '';
    try {
      const j = await (await dfetch(API + '/about?fields=user(emailAddress)', {}, interactive)).json();
      email = (j && j.user && j.user.emailAddress) || '';
    } catch (e) { if (e.auth) throw e; /* about not available: skip the check */ }
    if (email && !skipCompare) {
      if (cfg.email && cfg.email.toLowerCase() !== email.toLowerCase()) {
        token = null;
        throw authError('Google signed in as ' + email + ', but Drive sync on this device uses ' + cfg.email + '. Sign in with ' + cfg.email + ' again.');
      }
      if (!cfg.email) { cfg.email = email; saveCfg(); }
    }
    if (!skipCompare) accountChecked = true;
    return email;
  }

  // ---------- encrypted file formats ----------
  async function buildSyncText(list) {
    // NOTE: JSON.stringify runs synchronously, so the snapshot is taken at call time.
    const inner = JSON.stringify({ fhsExportType: 'all', exportedAt: new Date().toISOString(), members: list });
    const payload = await encryptText(inner, syncKey);
    return JSON.stringify({ fhsDriveSync: 1, app: 'my-health', salt: cfg.salt, iterVer: cfg.iterVer, updatedAt: new Date().toISOString(), payload: payload });
  }
  async function openSyncText(text, key) {
    let env;
    try { env = JSON.parse(text); } catch (e) { throw new Error('The Drive sync file is damaged.'); }
    if (!env || env.fhsDriveSync !== 1 || typeof env.payload !== 'string') throw new Error('The Drive sync file is not a My Health file.');
    let inner;
    try { inner = JSON.parse(await decryptText(env.payload, key)); }
    catch (e) { const err = new Error('Wrong passcode for the Drive data.'); err.code = 'BADKEY'; throw err; }
    if (!inner || !Array.isArray(inner.members)) throw new Error('The Drive sync file has no member data.');
    inner.members.forEach((m) => {
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.name !== 'string') throw new Error('The Drive sync file has an invalid member.');
    });
    return { env: env, members: inner.members };
  }
  function idbAllKeys() {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys();
      rq.onsuccess = () => resolve(new Set(rq.result));
      rq.onerror = () => reject(rq.error);
    }));
  }
  function localIsDemoOnly() {
    try {
      const demo = new Set(DEMO_DATA.map(d => d.id));
      return members.length > 0 && members.every(m => demo.has(m.id));
    } catch (e) { return false; }
  }
  function modalBlocking() {
    return Array.from(document.querySelectorAll('.modal-overlay.active')).some(el => NOT_BLOCKING_MODALS.indexOf(el.id) === -1);
  }
  function applyMerged(merged) {
    const prev = members;
    applying = true;
    try {
      members = merged;
      if (!saveData()) { members = prev; throw new Error('Could not save the synced data on this device (storage may be full).'); }
    } finally { applying = false; }
    if (typeof currentMemberId !== 'undefined' && currentMemberId && !members.some(m => m.id === currentMemberId && !m.deletedAt)) {
      currentMemberId = null; currentTab = 'overview';
    }
    renderMemberList(); renderMain(); updateConflictBadge();
  }

  // ---------- the sync itself ----------
  // opts: interactive (may open the Google sign-in), force (re-download even if
  // unchanged), adoptRemote (first connect on a device that only has the sample
  // data: take Drive's data as is), _attempt (internal retry counter).
  async function doSync(opts) {
    if (!cfg.connected) return;
    if (!navigator.onLine) { setStatus('error', 'Offline - will sync when you are back online.'); return; }
    if (!isEncryptionEnabled()) { setStatus('paused', 'Turn your passcode back on to keep syncing.'); return; }
    if (!isUnlocked() || !membersLoaded) { setStatus('locked', 'Unlock the app to sync.'); return; }
    try { await keyPromise; } catch (e) { /* handled by the syncKey check below */ }
    if (!syncKey) { setStatus('locked', 'Unlock the app to sync.'); return; }

    setStatus('syncing', 'Syncing...');
    await getToken(!!opts.interactive);
    if (!accountChecked) await checkAccount(!!opts.interactive);

    const files = await listFiles(!!opts.interactive);
    const syncFiles = files.filter(f => f.name === SYNC_FILE)
      .sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
    const syncFile = syncFiles[0] || null;
    const attFiles = new Map();
    files.forEach((f) => {
      if (f.name.indexOf(ATT_PREFIX) === 0 && f.name.slice(-ATT_SUFFIX.length) === ATT_SUFFIX) {
        attFiles.set(f.name.slice(ATT_PREFIX.length, -ATT_SUFFIX.length), f);
      }
    });

    // 1. pull + merge when Drive changed since we last looked
    let remoteMembers = null;
    let newConflicts = 0;
    let conflictRemoteHash = ''; // set when this round's merge found conflicts (see the push decision below)
    if (syncFile && (opts.force || syncFile.modifiedTime !== cfg.lastRemoteModified)) {
      remoteMembers = (await openSyncText(await downloadText(syncFile.id), syncKey)).members;
      migrateSyncFields(remoteMembers);
      let merged, conflicts = [];
      if (opts.adoptRemote) {
        merged = remoteMembers;
      } else {
        const r = FHSMerge.mergeMembers(members, remoteMembers, { intakeCutoff: intakeCutoffDate() });
        merged = r.members; conflicts = r.conflicts;
      }
      if (stable(merged) !== stable(members)) {
        if (modalBlocking()) { // don't swap data under a form the person is filling in
          setStatus('blocked', 'Waiting for you to close the open form...');
          syncSoon(15000, opts);
          return;
        }
        applyMerged(merged);
      }
      if (conflicts.length) {
        conflictRemoteHash = hashStr(stable(remoteMembers));
        const byMember = new Map();
        conflicts.forEach((c) => {
          const mid = c.path && c.path[0];
          if (!byMember.has(mid)) byMember.set(mid, []);
          byMember.get(mid).push(c);
        });
        byMember.forEach((list, mid) => {
          const m = members.find(x => x.id === mid);
          newConflicts += appendConflicts(mid, m ? m.name : '', list);
        });
        if (newConflicts) updateConflictBadge();
      }
    }

    // 2. attachment files (bytes live in IndexedDB; Drive holds one file per id)
    const liveIds = FHSMerge.collectLiveAttachmentIds(members);
    const localKeys = await idbAllKeys();
    const toDown = liveIds.filter(id => !localKeys.has(id) && attFiles.has(id));
    const toUp = liveIds.filter(id => localKeys.has(id) && !attFiles.has(id));
    let attFailed = 0, done = 0;
    for (const id of toDown) {
      setStatus('syncing', 'Downloading attachments (' + (++done) + '/' + (toDown.length + toUp.length) + ')...');
      try {
        const env = JSON.parse(await downloadText(attFiles.get(id).id));
        const dataUrl = await decryptText(env.payload, syncKey);
        await idbPut(id, dataUrl); // same id as on the other device, re-encrypted with THIS device's key
      } catch (e) { if (e.auth) throw e; attFailed++; console.warn('Attachment download failed', id, e); }
    }
    for (const id of toUp) {
      setStatus('syncing', 'Uploading attachments (' + (++done) + '/' + (toDown.length + toUp.length) + ')...');
      try {
        const dataUrl = await idbGet(id);
        if (typeof dataUrl !== 'string') continue;
        const text = JSON.stringify({ fhsDriveAtt: 1, payload: await encryptText(dataUrl, syncKey) });
        const f = await uploadFile(ATT_PREFIX + id + ATT_SUFFIX, null, text);
        attFiles.set(id, { id: f.id, name: f.name, modifiedTime: f.modifiedTime });
      } catch (e) { if (e.auth) throw e; attFailed++; console.warn('Attachment upload failed', id, e); }
    }
    if (toDown.length && typeof renderMain === 'function') renderMain();

    // 3. push the member data when this device has something Drive does not
    let needUpload;
    if (!syncFile) needUpload = true;
    else if (remoteMembers) {
      needUpload = stable(members) !== stable(remoteMembers);
      // While a conflict is unresolved each device keeps ITS OWN version (nothing is
      // lost). If both then pushed after every pull they would overwrite each other
      // on every sync for ever. So: when this exact Drive content already produced
      // this conflict and we have nothing new of our own, do not push again.
      if (needUpload && conflictRemoteHash && conflictRemoteHash === cfg.conflictRemoteHash &&
          hashStr(stable(members)) === cfg.lastSyncHash) needUpload = false;
    }
    else needUpload = hashStr(stable(members)) !== cfg.lastSyncHash;

    if (needUpload && syncFile) {
      // Another device may have pushed while we were working: look again before overwriting.
      const meta = await (await dfetch(API + '/files/' + syncFile.id + '?fields=modifiedTime')).json();
      if (meta.modifiedTime !== syncFile.modifiedTime) {
        const attempt = (opts._attempt || 0) + 1;
        if (attempt > 3) throw new Error('Drive keeps changing from another device. Try again in a moment.');
        return doSync(Object.assign({}, opts, { force: true, _attempt: attempt, adoptRemote: false }));
      }
    }
    // Snapshot taken in ONE synchronous step, so an edit made while we upload is
    // never recorded as synced (its hash will differ and it goes up next round).
    const snapHash = hashStr(stable(members));
    if (needUpload) {
      setStatus('syncing', 'Uploading...');
      const text = await buildSyncText(members);
      const f = await uploadFile(SYNC_FILE, syncFile ? syncFile.id : null, text);
      cfg.lastRemoteModified = f.modifiedTime;
    } else if (syncFile) {
      cfg.lastRemoteModified = syncFile.modifiedTime;
    }
    cfg.lastSyncHash = snapHash;
    if (remoteMembers) cfg.conflictRemoteHash = conflictRemoteHash; // only a fresh download says anything new

    // 4. tidy: attachment files nobody references any more (and are old enough
    //    that no device can still be about to reference them)
    if (members.length && !attFailed) {
      const live = new Set(liveIds);
      const cutoff = Date.now() - ORPHAN_DAYS * 86400000;
      let removed = 0;
      for (const [id, f] of attFiles) {
        if (removed >= 20) break;
        if (!live.has(id) && Date.parse(f.modifiedTime) < cutoff) {
          try { await deleteFile(f.id); removed++; } catch (e) { if (e.auth) throw e; }
        }
      }
    }

    cfg.lastSyncAt = Date.now();
    cfg.lastError = '';
    saveCfg();
    let msg = 'Up to date.';
    if (newConflicts) msg = newConflicts + ' item(s) were edited on two devices - open "Conflicts" at the top to review.';
    else if (attFailed) msg = attFailed + ' attachment(s) could not be synced yet - will retry.';
    setStatus(attFailed || newConflicts ? 'warn' : 'ok', msg);
  }

  function handleError(e) {
    console.error('Drive sync:', e);
    let state = 'error', text;
    if (e && e.auth) { token = null; state = 'auth'; text = (e.message || 'Sign in to Google again') + ' Tap "Sync now" to sign in.'; }
    else if (e && e.code === 'BADKEY') { state = 'badkey'; text = 'The data in Drive was made with a different passcode (or was reset on another device). Tap "Reconnect".'; }
    else if (!navigator.onLine || e instanceof TypeError) text = 'Could not reach Google (offline or blocked). Will retry.';
    else text = (e && e.message) || String(e);
    cfg.lastError = text; saveCfg();
    setStatus(state, text);
  }

  // single-flight: while a sync runs, further requests collapse into one re-run
  async function syncNow(opts) {
    if (!cfg.connected) return;
    opts = opts || {};
    if (running) { rerun = Object.assign({}, rerun || {}, opts); return; }
    running = true;
    try { await doSync(opts); }
    catch (e) { handleError(e); }
    finally {
      running = false;
      if (rerun) { const o = rerun; rerun = null; syncSoon(1500, o); }
    }
  }
  function syncSoon(ms, opts) {
    if (!cfg.connected) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; syncNow(opts); }, ms);
  }

  // ---------- hooks called from app.js ----------
  function markDirty() { if (!applying && cfg.connected) syncSoon(DEBOUNCE_MS); }
  function onPasscode(passcode) { // right after a successful cryptoSetup / cryptoUnlock
    if (!cfg.connected || !cfg.salt) return;
    keyPromise = deriveKeyFromPasscode(passcode, cfg.salt, PBKDF2_CONFIGS[cfg.iterVer || PBKDF2_ITER_VERSION])
      .then((k) => { syncKey = k; return k; })
      .catch(() => null);
    keyPromise.then(() => { if (typeof membersLoaded !== 'undefined' && membersLoaded) syncSoon(500, {}); });
    renderUI();
  }
  function onLock() { syncKey = null; keyPromise = Promise.resolve(null); renderUI(); }
  function onAppReady() { if (cfg.connected) syncSoon(800, {}); renderUI(); }

  // ---------- Settings UI ----------
  function setStatus(state, text) { status = { state: state, text: text }; renderUI(); }
  function renderUI() {
    const statusEl = $('driveStatus');
    if (!statusEl) return;
    statusEl.style.whiteSpace = 'pre-line';
    const connected = !!cfg.connected;
    const bConnect = $('btnDriveConnect'), bSync = $('btnDriveSyncNow'), bOff = $('btnDriveDisconnect');
    bConnect.style.display = (!connected || status.state === 'badkey') ? 'flex' : 'none';
    bConnect.textContent = connected ? '🔁 Reconnect Google Drive' : '☁️ Connect Google Drive';
    bSync.style.display = bOff.style.display = connected ? 'flex' : 'none';
    if (!connected) {
      statusEl.textContent = 'Keeps all devices in step through your own Google Drive. Everything is encrypted on this device before it is uploaded.';
      return;
    }
    let line = 'Connected' + (cfg.email ? ' as ' + cfg.email : '') + ' · last synced ' + timeAgo(cfg.lastSyncAt);
    if (status.text) line += '\n' + status.text;
    else if (!isUnlocked()) line += '\nUnlock the app to sync.';
    statusEl.textContent = line;
  }

  // ----- connect dialog -----
  let step = 1, connectPass = '';
  function connectError(msg) { $('driveConnectError').textContent = msg || ''; }
  function setStep(n) {
    step = n;
    $('drivePasscodeGroup').style.display = n === 1 ? 'block' : 'none';
    $('driveSignInNote').style.display = n === 2 ? 'block' : 'none';
    $('btnDriveConnectGo').textContent = n === 1 ? 'Continue' : 'Sign in with Google';
  }
  async function openConnect() {
    if (!isEncryptionEnabled()) {
      alert('Turn on a passcode first (Settings → Passcode & biometrics). Drive sync encrypts your data with it.');
      return;
    }
    if (!(await ensureUnlocked())) return;
    connectPass = '';
    $('drivePasscodeInput').value = '';
    connectError('');
    setStep(1);
    $('btnDriveConnectGo').disabled = false;
    $('driveConnectModal').classList.add('active');
    setTimeout(() => $('drivePasscodeInput').focus(), 50);
    loadGis().then(ensureTokenClient).catch((e) => connectError(e.message)); // preload so the sign-in click is instant
  }
  function closeConnect() {
    connectPass = '';
    $('drivePasscodeInput').value = '';
    $('driveConnectModal').classList.remove('active');
  }
  async function connectGo() {
    const btn = $('btnDriveConnectGo');
    connectError('');
    if (step === 1) {
      const pass = $('drivePasscodeInput').value;
      if (!pass) { connectError('Enter your passcode.'); return; }
      btn.disabled = true;
      try {
        const vault = getCryptoConfig();
        const key = await deriveKeyFromPasscode(pass, vault.salt, PBKDF2_CONFIGS[vault.iterVer || 1]);
        if ((await decryptText(vault.verifier, key).catch(() => null)) !== 'verify-ok') { connectError('Incorrect passcode.'); return; }
      } finally { btn.disabled = false; }
      connectPass = pass;
      $('drivePasscodeInput').value = '';
      setStep(2);
      return;
    }
    // step 2 - runs straight from the click, so the browser allows the Google pop-up
    btn.disabled = true;
    try {
      await loadGis(); ensureTokenClient();
      token = null; accountChecked = false;
      await getToken(true, 'select_account');
      const email = await checkAccount(true, true); // any account may be chosen here

      const files = await listFiles(true);
      const syncFile = files.filter(f => f.name === SYNC_FILE)
        .sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)))[0] || null;
      const demoOnly = localIsDemoOnly();
      let salt, iterVer, key, adoptRemote = false;

      if (syncFile) {
        const env = JSON.parse(await downloadText(syncFile.id));
        salt = env.salt; iterVer = env.iterVer || PBKDF2_ITER_VERSION;
        key = await deriveKeyFromPasscode(connectPass, salt, PBKDF2_CONFIGS[iterVer]);
        let readable = true;
        try { await openSyncText(JSON.stringify(env), key); } catch (e) { if (e.code === 'BADKEY') readable = false; else throw e; }
        if (!readable) {
          if (!confirm('The My Health data already in this Google Drive was made with a different passcode, so it cannot be opened with this one.\n\nReplace it with the data on THIS device? Your other devices will have to reconnect afterwards.')) { return; }
          for (const f of files) await deleteFile(f.id);
          salt = null;
        } else if (demoOnly) {
          if (!confirm('This device only has the sample data.\n\nReplace it with the data from your Google Drive?')) return;
          adoptRemote = true;
        } else if (!confirm('Your Google Drive already has My Health data.\n\nIt will be merged with the data on this device, member by member. Nothing is deleted. Continue?')) {
          return;
        }
      } else if (demoOnly && !confirm('This device only has the sample data, and nothing is stored in Drive yet.\n\nUpload the sample data anyway?')) {
        return;
      }
      if (!salt) {
        salt = bufToB64(crypto.getRandomValues(new Uint8Array(16)));
        iterVer = PBKDF2_ITER_VERSION;
        key = await deriveKeyFromPasscode(connectPass, salt, PBKDF2_CONFIGS[iterVer]);
      }

      cfg = { connected: true, salt: salt, iterVer: iterVer, email: email || cfg.email || '', lastSyncAt: 0, lastRemoteModified: '', lastSyncHash: '', lastError: '' };
      saveCfg();
      syncKey = key; keyPromise = Promise.resolve(key);
      accountChecked = true; // the token in hand belongs to the account just saved
      closeConnect();
      setStatus('syncing', 'Syncing...');
      syncNow({ interactive: true, force: true, adoptRemote: adoptRemote });
    } catch (e) {
      connectError(describe(e));
    } finally { btn.disabled = false; }
  }

  async function disconnect() {
    if (!confirm('Disconnect Google Drive on this device?\n\nYour data stays on this device. Other devices keep syncing with Drive.')) return;
    if (confirm('Also delete the synced copy that is stored in your Google Drive?\n\nOK = delete it from Drive.\nCancel = leave it in Drive.')) {
      try {
        const files = await listFiles(true);
        for (const f of files) await deleteFile(f.id);
      } catch (e) {
        alert('Could not delete the copy in Drive: ' + describe(e) + '\n\nYou can remove it in your Google Account → Data & privacy → third-party apps.');
      }
    }
    clearTimeout(timer);
    localStorage.removeItem(CFG_KEY);
    cfg = {}; syncKey = null; token = null; accountChecked = false; keyPromise = Promise.resolve(null);
    setStatus('off', '');
  }

  function bindUI() {
    if (!$('btnDriveConnect')) return;
    $('btnDriveConnect').addEventListener('click', openConnect);
    $('btnDriveConnectCancel').addEventListener('click', closeConnect);
    $('btnDriveConnectGo').addEventListener('click', connectGo);
    $('drivePasscodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectGo(); });
    $('btnDriveSyncNow').addEventListener('click', () => {
      if (running) return;
      syncNow({ interactive: true, force: true });
    });
    $('btnDriveDisconnect').addEventListener('click', disconnect);
    new MutationObserver(renderUI).observe($('settingsModal'), { attributes: true, attributeFilter: ['class'] });
    renderUI();
  }

  // ---------- triggers ----------
  document.addEventListener('visibilitychange', () => { if (cfg.connected) syncSoon(document.hidden ? 0 : 1500, {}); });
  window.addEventListener('online', () => { if (cfg.connected) syncSoon(1500, {}); });
  setInterval(() => { if (cfg.connected && !document.hidden) syncSoon(0, {}); }, POLL_MS);

  window.FHSDrive = { markDirty: markDirty, onPasscode: onPasscode, onLock: onLock, onAppReady: onAppReady, syncNow: syncNow, _state: () => ({ cfg: cfg, status: status }) };
  bindUI();
  if (typeof membersLoaded !== 'undefined' && membersLoaded && typeof isUnlocked === 'function' && isUnlocked()) onAppReady();
})();
