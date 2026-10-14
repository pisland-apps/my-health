// ========== FHS MERGE ENGINE ==========
// Pure functions implementing the field/array-level merge described in
// MERGE_SYNC_DESIGN.md. No DOM, no I/O, no randomness, no wall-clock reads
// except inside a couple of helpers that are never called during a merge
// itself.
//
// Entry point: FHSMerge.mergeMembers(localMembers, remoteMembers) ->
//   { members, conflicts }
//
// Everything below is wrapped in a UMD factory rather than left as bare
// top-level `const`/`function` declarations, DELIBERATELY: this file is
// loaded as a plain <script> alongside app.js's own (much larger) global
// script, and several of the shorter names here (MEMBER_SCALAR_FIELDS,
// freshFieldVersions) already exist as app.js globals for its own local-
// editing needs. Two top-level `const` declarations of the same name
// across separate <script> tags in the same page throw a SyntaxError at
// parse time and would take the ENTIRE app down - not just silently
// misbehave. The factory function below gives every name here its own
// scope; only the single `FHSMerge` object is actually exposed globally
// (or via module.exports under Node for merge-engine.test.js).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.FHSMerge = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

// ---------- generic helpers ----------

// Lamport-clock comparison ONLY - never reads updatedAt. See design 1.1.
function mergeEntityMeta(local, remote) {
  const lv = Number.isFinite(local && local.version) ? local.version : 1;
  const rv = Number.isFinite(remote && remote.version) ? remote.version : 1;
  if (lv > rv) return 'local';
  if (rv > lv) return 'remote';
  return 'tie';
}

const SYNC_META_KEYS = ['version', 'updatedAt', 'deletedAt', 'schemaVersion'];


// Picks out just the given keys (or, with no key list, everything except
// the sync-metadata keys) for a content-equality / conflict comparison.
// This is what keeps a change to a NESTED child (e.g. one attachment) from
// falsely reading as a conflict on its PARENT record's own scalar fields -
// every entity type with nested syncable children passes its own scalar
// key list here rather than relying on the default "everything but meta".
function projectForCompare(obj, scalarKeys) {
  if (scalarKeys) {
    const out = {};
    scalarKeys.forEach(k => { out[k] = obj ? obj[k] : undefined; });
    return out;
  }
  const out = Object.assign({}, obj);
  SYNC_META_KEYS.forEach(k => { delete out[k]; });
  return out;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- id-keyed array merge (records, reminders, historyEntries,
// and members themselves at the top level) ----------
//
// opts:
//   path            - array of ids/keys for this array's location, purely
//                      for conflict-entry provenance/debugging
//   conflicts       - array conflicts get pushed onto (mutated)
//   ancestorTombstoned - true if an ancestor of every item here is already
//                      tombstoned; suppresses conflict reporting (design 1.7)
//                      but merging itself still happens (still need a
//                      correct union so an un-delete or "keep both" stays consistent)
//   scalarKeys      - keys to compare for conflict/equality (design: every
//                      entity type with nested syncable children MUST pass
//                      this, or child-only differences will misfire as a
//                      conflict on the parent's own fields)
//   mergeChildren(winner, localItem, remoteItem, winnerTombstoned) - called
//                      for every id in the union (localItem/remoteItem may
//                      be undefined for a one-sided id) to recursively
//                      merge that item's own nested syncable children into
//                      `winner` (mutate in place). Optional.
function mergeSyncArray(localArr, remoteArr, opts) {
  opts = opts || {};
  const path = opts.path || [];
  const conflicts = opts.conflicts || [];
  const ancestorTombstoned = !!opts.ancestorTombstoned;
  const scalarKeys = opts.scalarKeys || null;
  const mergeChildren = opts.mergeChildren || null;

  const localById = new Map((localArr || []).map(x => [x.id, x]));
  const remoteById = new Map((remoteArr || []).map(x => [x.id, x]));
  const allIds = Array.from(new Set([].concat(
    Array.from(localById.keys()), Array.from(remoteById.keys())
  )));

  return allIds.map(id => {
    const l = localById.get(id);
    const r = remoteById.get(id);
    let winner;

    if (l && !r) {
      winner = Object.assign({}, l);
    } else if (r && !l) {
      winner = Object.assign({}, r);
    } else {
      const outcome = mergeEntityMeta(l, r);
      if (outcome === 'local') {
        winner = Object.assign({}, l);
      } else if (outcome === 'remote') {
        winner = Object.assign({}, r);
      } else {
        // version tie
        const lProj = projectForCompare(l, scalarKeys);
        const rProj = projectForCompare(r, scalarKeys);
        if (deepEqual(lProj, rProj)) {
          winner = Object.assign({}, l);
        } else {
          if (!ancestorTombstoned) {
            // Store the FULL entities, not the scalarKeys-projected ones
            // used for the equality/conflict check above - a "keep both"
            // resolution (duplicating the remote side as a new record) or
            // simply "keep remote" needs the complete object (attachments
            // included), not just the fields that were compared.
            conflicts.push({
              entityId: id,
              baseVersion: l.version,
              path: path.concat([id]),
              local: l,
              remote: r
            });
          }
          // Conflict-output contract (design 1.5): keep local content,
          // remote goes ONLY into the conflict entry above.
          winner = Object.assign({}, l);
        }
      }
    }

    const winnerTombstoned = ancestorTombstoned || !!winner.deletedAt;
    if (mergeChildren) mergeChildren(winner, l, r, winnerTombstoned);
    return winner;
  });
}

// ---------- attachment array merge (id + tombstone only, no version -
// design 1.9/2.2) ----------
function mergeAttachmentArray(localArr, remoteArr) {
  const localById = new Map((localArr || []).map(x => [x.id, x]));
  const remoteById = new Map((remoteArr || []).map(x => [x.id, x]));
  const allIds = Array.from(new Set([].concat(
    Array.from(localById.keys()), Array.from(remoteById.keys())
  )));
  return allIds.map(id => {
    const l = localById.get(id);
    const r = remoteById.get(id);
    if (l && r) {
      // Prefer local's own fields (name/path/type/thumb/size are set once
      // at upload and never edited - see design 1.9 - so which side's copy
      // wins for those doesn't matter); OR the tombstone so either side
      // deleting it sticks.
      return Object.assign({}, l, { deletedAt: l.deletedAt || r.deletedAt || null });
    }
    return Object.assign({}, l || r);
  });
}

// ---------- member scalar fields (per-field version - design 2.1) ----------
const MEMBER_SCALAR_FIELDS = [
  'name', 'nameZh', 'nameZhAvatarIdx', 'gender', 'birth', 'blood',
  'height', 'allergies', 'emergency', 'bloodTypeAttachment'
];

function freshFieldVersions() {
  const fv = {};
  MEMBER_SCALAR_FIELDS.forEach(f => { fv[f] = 1; });
  return fv;
}

// Merges local/remote scalar fields into `winner` (mutated in place).
// Independent of whatever the member's own top-level `version` decided -
// see the note in mergeMemberPair for why these two are deliberately split.
// Value used for the TIE equality check only (never for what actually gets
// applied/stored) - bloodTypeAttachment needs special handling because an
// exported copy always carries the photo's full `.data` (embedded for
// portability), while the live local copy never does (it's stripped once
// persisted to IndexedDB - see app.js's persistAttachmentsToIdb). Comparing
// those two shapes directly would call an untouched re-import of the exact
// same file a "conflict" on every single sync, since one side always has
// an extra `.data` field the other doesn't. Strip it before comparing,
// same way the rest of the app treats attachment identity as id-based, not
// byte-content-based.
function fieldCompareValue(f, val) {
  if (f === 'bloodTypeAttachment' && val && typeof val === 'object' && 'data' in val) {
    const copy = Object.assign({}, val);
    delete copy.data;
    return copy;
  }
  return val;
}

function mergeMemberFields(winner, local, remote, conflicts, path) {
  const lfv = (local && local.fieldVersion) || freshFieldVersions();
  const rfv = (remote && remote.fieldVersion) || freshFieldVersions();
  winner.fieldVersion = Object.assign({}, lfv);
  MEMBER_SCALAR_FIELDS.forEach(f => {
    const lv = lfv[f] || 1;
    const rv = rfv[f] || 1;
    if (lv > rv) {
      winner[f] = local ? local[f] : winner[f];
      winner.fieldVersion[f] = lv;
    } else if (rv > lv) {
      winner[f] = remote ? remote[f] : winner[f];
      winner.fieldVersion[f] = rv;
    } else {
      // tie
      const lVal = local ? local[f] : undefined;
      const rVal = remote ? remote[f] : undefined;
      if (!deepEqual(fieldCompareValue(f, lVal), fieldCompareValue(f, rVal))) {
        conflicts.push({
          entityId: winner.id,
          field: f,
          baseVersion: lv,
          path: path.concat([winner.id, f]),
          local: lVal,
          remote: rVal
        });
      }
      // contract: keep local's value on a field-level conflict too
      winner[f] = local ? local[f] : winner[f];
      winner.fieldVersion[f] = lv;
    }
  });
}

// ---------- scalar keys (children such as attachments are merged
// separately - design 1.7) ----------
const RECORD_SCALAR_KEYS = ['date', 'type', 'title', 'details', 'tags', 'vitals'];
const REMINDER_SCALAR_KEYS = ['title', 'dueDate', 'repeatMonths', 'notes'];
// Daily Plan items. `order` (display position) and `archivedRecordId` are
// deliberately NOT listed: two devices that only differ in those must never
// raise a conflict (reordering is cosmetic; archiving is a one-shot helper).
const PLAN_ITEM_SCALAR_KEYS = ['kind', 'name', 'dose', 'meal', 'schedule', 'time', 'icon', 'color', 'note', 'startDate', 'endDate'];

// ---------- Daily Plan: intake log ----------
// Last calendar day of the month that `dateStr` (YYYY-MM-DD) falls in.
function monthEndStr(dateStr) {
  const y = parseInt(String(dateStr).slice(0, 4), 10);
  const m = parseInt(String(dateStr).slice(5, 7), 10);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return String(dateStr).slice(0, 8) + String(last).padStart(2, '0');
}

// A log entry is "compacted" once its WHOLE month lies before the cutoff
// date. Used identically by the app's local compaction and by the merge, so
// an old device re-importing old detail can never resurrect rows that were
// already folded into a monthly summary.
function isCompactedDate(dateStr, cutoff) {
  return !!cutoff && typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && monthEndStr(dateStr) < cutoff;
}

// Intake entries never raise conflicts: two devices logging the same dose is
// normal. Rules are symmetric (merge(a,b) === merge(b,a) in content):
//   higher version wins; on a tie prefer a live entry over a tombstone, then
//   'taken' over 'skipped', then the EARLIER takenAt, then the smaller JSON.
function pickIntake(l, r) {
  const lv = Number.isFinite(l.version) ? l.version : 1;
  const rv = Number.isFinite(r.version) ? r.version : 1;
  if (lv !== rv) return lv > rv ? l : r;
  if (!!l.deletedAt !== !!r.deletedAt) return l.deletedAt ? r : l;
  if (l.status !== r.status) return l.status === 'taken' ? l : r;
  const lt = l.takenAt || '', rt = r.takenAt || '';
  if (lt !== rt) { if (!lt) return r; if (!rt) return l; return lt < rt ? l : r; }
  return JSON.stringify(l) <= JSON.stringify(r) ? l : r;
}

function mergeIntakeLog(localArr, remoteArr, cutoff) {
  const byId = new Map();
  [].concat(localArr || [], remoteArr || []).forEach(e => {
    if (!e || typeof e.id !== 'string') return;
    const prev = byId.get(e.id);
    byId.set(e.id, prev ? pickIntake(prev, e) : e);
  });
  return Array.from(byId.values())
    .filter(e => !isCompactedDate(e.date, cutoff))
    .map(e => Object.assign({}, e));
}

// Monthly summaries are derived from an append-only log, so they only ever
// grow: per-field max is order-independent and idempotent.
function mergeIntakeSummaries(localArr, remoteArr) {
  const byId = new Map();
  const maxNum = (a, b) => (a == null ? b : (b == null ? a : Math.max(a, b)));
  [].concat(localArr || [], remoteArr || []).forEach(s => {
    if (!s || typeof s.id !== 'string') return;
    const prev = byId.get(s.id);
    if (!prev) { byId.set(s.id, Object.assign({}, s)); return; }
    byId.set(s.id, Object.assign({}, prev, {
      taken: maxNum(prev.taken, s.taken),
      skipped: maxNum(prev.skipped, s.skipped),
      expected: maxNum(prev.expected, s.expected)
    }));
  });
  return Array.from(byId.values());
}

// Per-member plan settings (slot times/labels): one small object, picked
// whole by Lamport version; a tie keeps local (no conflict entry - it is a
// preference, not a record).
function mergePlanSettings(local, remote) {
  if (!local) return remote ? Object.assign({}, remote) : local;
  if (!remote) return Object.assign({}, local);
  const lv = Number.isFinite(local.version) ? local.version : 1;
  const rv = Number.isFinite(remote.version) ? remote.version : 1;
  return Object.assign({}, rv > lv ? remote : local);
}

// ---------- one member pair ----------
//
// A member's own `version` conflates two different kinds of event (member
// deletion, AND any scalar-field edit - see saveMember's bumpFieldVersions,
// which bumps the member's version too). That makes it unsuitable as the
// sole signal for "is there a scalar-field conflict" - two people editing
// DIFFERENT fields would show tied-or-differing versions with genuinely no
// conflict, which fieldVersion already resolves per-field. So member merge
// deliberately splits into two independent steps that don't gate each other:
//   1) mergeEntityMeta on the member's own version decides {version,
//      deletedAt, schemaVersion, updatedAt} as one group (governs identity/
//      tombstone status only).
//   2) mergeMemberFields ALWAYS runs, independently, using fieldVersion.
// Nested children (records/customReminders/historyEntries) are merged
// independently of both.
function mergeMemberPair(local, remote, conflicts, opts) {
  opts = opts || {};
  const outcome = mergeEntityMeta(local, remote);
  const metaSource = outcome === 'remote' ? remote : local; // tie defaults to local, no conflict entry needed here - see note above
  const winner = {
    id: local.id,
    version: metaSource.version,
    deletedAt: metaSource.deletedAt,
    schemaVersion: metaSource.schemaVersion,
    updatedAt: metaSource.updatedAt
  };

  mergeMemberFields(winner, local, remote, conflicts, []);

  const tombstoned = !!winner.deletedAt;
  winner.records = mergeSyncArray(local.records, remote.records, {
    path: [local.id, 'records'], conflicts, ancestorTombstoned: tombstoned,
    scalarKeys: RECORD_SCALAR_KEYS,
    mergeChildren: (w, l, r) => { w.attachments = mergeAttachmentArray(l && l.attachments, r && r.attachments); }
  });
  winner.customReminders = mergeSyncArray(local.customReminders, remote.customReminders, {
    path: [local.id, 'customReminders'], conflicts, ancestorTombstoned: tombstoned,
    scalarKeys: REMINDER_SCALAR_KEYS
  });
  winner.historyEntries = mergeSyncArray(local.historyEntries, remote.historyEntries, {
    path: [local.id, 'historyEntries'], conflicts, ancestorTombstoned: tombstoned
  });
  // Daily Plan (v62). Each key is only written when at least one side has it,
  // so members that never used the feature stay byte-identical.
  if (local.planItems || remote.planItems) {
    winner.planItems = mergeSyncArray(local.planItems, remote.planItems, {
      path: [local.id, 'planItems'], conflicts, ancestorTombstoned: tombstoned,
      scalarKeys: PLAN_ITEM_SCALAR_KEYS
    });
  }
  if (local.intakeLog || remote.intakeLog) {
    winner.intakeLog = mergeIntakeLog(local.intakeLog, remote.intakeLog, opts.intakeCutoff);
  }
  if (local.intakeSummaries || remote.intakeSummaries) {
    winner.intakeSummaries = mergeIntakeSummaries(local.intakeSummaries, remote.intakeSummaries);
  }
  if (local.planSettings || remote.planSettings) {
    winner.planSettings = mergePlanSettings(local.planSettings, remote.planSettings);
  }
  // history stays a plain string for now (design 1.10 - v1 UI still reads
  // m.history, historyEntries is a shadow not yet wired as source of
  // truth - see MERGE_SYNC_DESIGN.md 2.1). Until that wiring lands, keep
  // whichever side won the meta/version comparison, since there is no
  // richer signal to merge it by yet.
  winner.history = metaSource.history;

  return winner;
}

// ---------- top-level entry point ----------
// mergeMembers(localMembers, remoteMembers, opts) -> { members, conflicts }
// opts.intakeCutoff (YYYY-MM-DD, optional): Daily Plan intake entries whose
// whole month lies before it are dropped (already folded into summaries).
// Pure: no mutation of either input array or its objects (mergeSyncArray/
// mergeMemberPair always copy before mutating a winner).
function mergeMembers(localMembers, remoteMembers, opts) {
  const conflicts = [];
  const localById = new Map((localMembers || []).map(x => [x.id, x]));
  const remoteById = new Map((remoteMembers || []).map(x => [x.id, x]));
  const allIds = Array.from(new Set([].concat(
    Array.from(localById.keys()), Array.from(remoteById.keys())
  )));

  const members = allIds.map(id => {
    const l = localById.get(id);
    const r = remoteById.get(id);
    if (l && !r) return JSON.parse(JSON.stringify(l));
    if (r && !l) return JSON.parse(JSON.stringify(r));
    return mergeMemberPair(l, r, conflicts, opts);
  });

  return { members, conflicts };
}

// ---------- attachment lifecycle helpers (v48) ----------
// Pure, like everything else in this file: no DOM, no IndexedDB, no
// randomness (ids come from the caller's genId). app.js does the actual
// byte copying / deleting; these only decide WHAT.

// Deep-clones `value` and gives EVERY `id` in the clone a fresh one:
// the entity itself, its nested entities, and
// its attachments. Returns { clone, attachments } where `attachments` lists
// { oldId, newId, att } for each attachment object in the clone, so the
// caller can copy the stored bytes from oldId to newId.
// Why not app.js's sanitizeIdsDeep: that only replaces ids that fail the
// safe-id pattern, so a valid id survives the clone and the "duplicate"
// ends up with the original's entity id and the original's attachment ids
// (two entities sharing one set of stored bytes).
// genId(kind) is called with 'att' for attachments, 'ent' for everything else.
function cloneWithFreshIds(value, genId) {
  const clone = (typeof structuredClone === 'function')
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
  const attachments = [];
  (function walk(node, isAtt) {
    if (Array.isArray(node)) { node.forEach(n => walk(n, isAtt)); return; }
    if (!node || typeof node !== 'object') return;
    if ('id' in node) {
      const oldId = node.id;
      node.id = genId(isAtt ? 'att' : 'ent');
      if (isAtt) attachments.push({ oldId, newId: node.id, att: node });
    }
    Object.keys(node).forEach(k => walk(node[k], k === 'attachments' || k === 'bloodTypeAttachment'));
  })(clone, false);
  return { clone, attachments };
}

// Ids of every attachment that is still in use anywhere inside `value`
// (a member, a members array, ...). An attachment counts as in use when
// neither it nor any entity containing it carries a `deletedAt`
// tombstone. Tombstoned things keep their metadata for sync, but their
// stored bytes are no longer needed. Reference counting by construction:
// the same id found in several live places is simply one entry.
function collectLiveAttachmentIds(value) {
  const ids = new Set();
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (node.deletedAt) return;
    Object.keys(node).forEach(k => {
      const v = node[k];
      if (k === 'attachments' && Array.isArray(v)) {
        v.forEach(a => {
          if (a && typeof a === 'object' && !a.deletedAt && typeof a.id === 'string') ids.add(a.id);
        });
      } else if (k === 'bloodTypeAttachment' && v && typeof v === 'object') {
        if (!v.deletedAt && typeof v.id === 'string') ids.add(v.id);
      } else {
        walk(v);
      }
    });
  })(value);
  return Array.from(ids);
}

// Every attachment object found anywhere inside `value`, tombstoned or not
// (under an `attachments` array or a `bloodTypeAttachment` field). The
// caller filters; this is just the finder (used to get at an attachment's
// raw `.data` when bringing a deleted entity back).
function collectAttachmentObjects(value) {
  const found = [];
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    Object.keys(node).forEach(k => {
      const v = node[k];
      if (k === 'attachments' && Array.isArray(v)) {
        v.forEach(x => { if (x && typeof x === 'object') found.push(x); });
      } else if (k === 'bloodTypeAttachment' && v && typeof v === 'object') {
        found.push(v);
      } else {
        walk(v);
      }
    });
  })(value);
  return found;
}

// ids that were in use before but are not any more (what an operation
// "killed"). Differential on purpose: it never proposes bytes the
// operation did not touch.
function orphanedAttachmentIds(beforeIds, afterIds) {
  const after = new Set(afterIds);
  return beforeIds.filter(id => !after.has(id));
}

// ---------- what the factory exposes as FHSMerge / module.exports ----------
return {
  mergeMembers,
  mergeMemberPair,
  mergeSyncArray,
  mergeAttachmentArray,
  mergeMemberFields,
  mergeEntityMeta,
  projectForCompare,
  deepEqual,
  MEMBER_SCALAR_FIELDS,
  freshFieldVersions,
  RECORD_SCALAR_KEYS, REMINDER_SCALAR_KEYS, PLAN_ITEM_SCALAR_KEYS,
  mergeIntakeLog, mergeIntakeSummaries, mergePlanSettings, isCompactedDate, monthEndStr,
  cloneWithFreshIds, collectLiveAttachmentIds, collectAttachmentObjects, orphanedAttachmentIds
};

}); // end UMD factory
