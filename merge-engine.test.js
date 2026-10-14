// Plain-Node property tests for merge-engine.js - no framework, run with:
//   node merge-engine.test.js
// Exits non-zero and prints failures if anything breaks.

const {
  mergeMembers, mergeSyncArray, mergeAttachmentArray, freshFieldVersions,
  cloneWithFreshIds, collectLiveAttachmentIds, collectAttachmentObjects, orphanedAttachmentIds,
  mergeIntakeLog, mergeIntakeSummaries, isCompactedDate, monthEndStr
} = require('./merge-engine.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${name}` + (detail ? `\n  ${detail}` : '')); }
}

// ---------- tiny seeded PRNG (mulberry32) for reproducible fuzzing ----------
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- fixture builders ----------
let uidCounter = 0;
function uid(prefix) { return `${prefix}${++uidCounter}`; }

function freshMeta(version) {
  return { version: version || 1, updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null, schemaVersion: 1 };
}

function makeRecord(id, overrides) {
  return Object.assign({
    id, date: '2026-01-01', type: 'Checkup', title: 'Visit', details: '', tags: [], vitals: {}, attachments: []
  }, freshMeta(), overrides || {});
}

function makeMember(id, overrides) {
  return Object.assign({
    id, name: 'Alice', nameZh: '', nameZhAvatarIdx: 0, gender: 'F', birth: '1990-01-01', blood: 'O',
    height: '160', allergies: '', emergency: '', bloodTypeAttachment: null,
    history: '', historyEntries: [],
    records: [makeRecord(uid('rec'))],
    customReminders: [],
    fieldVersion: freshFieldVersions()
  }, freshMeta(), overrides || {});
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

// ============================================================
// 1. Idempotence
// ============================================================
(function testIdempotence() {
  const local = [makeMember('m1')];
  const remote = clone(local);
  remote[0].records[0].title = 'Remote edit';
  remote[0].records[0].version = 2;

  const once = mergeMembers(clone(local), clone(remote));
  const twiceStep = mergeMembers(clone(once.members), clone(remote));

  ok('idempotence: members stable', deepJSON(once.members) === deepJSON(twiceStep.members),
    `once=${deepJSON(once.members)}\ntwice=${deepJSON(twiceStep.members)}`);
  ok('idempotence: conflict count stable', once.conflicts.length === twiceStep.conflicts.length);
})();

function deepJSON(x) { return JSON.stringify(x); }

// ============================================================
// 2. Commutativity (conflict queue contents, per design 1.11)
// ============================================================
(function testCommutativity() {
  const a = [makeMember('m1')];
  const b = clone(a);
  // force a genuine tie-version conflict on a scalar field
  b[0].name = 'Bob';
  b[0].fieldVersion.name = a[0].fieldVersion.name; // same version, different value -> conflict

  const ab = mergeMembers(clone(a), clone(b));
  const ba = mergeMembers(clone(b), clone(a));

  const keysOf = res => res.conflicts.map(c => JSON.stringify([c.entityId, c.field || null, c.baseVersion])).sort();
  ok('commutativity: conflict keys match', deepJSON(keysOf(ab)) === deepJSON(keysOf(ba)),
    `ab=${deepJSON(keysOf(ab))}\nba=${deepJSON(keysOf(ba))}`);
})();

// ============================================================
// 3. Associativity (conflict queue contents across 3 devices)
//
// mergeMembers only returns the conflicts discovered IN THAT CALL (by
// design - see 1.4: the caller is responsible for appending each merge's
// conflicts onto its own persisted queue, same as the real app will do on
// every import). So testing associativity correctly means accumulating
// conflicts across BOTH steps of each chain and comparing the unions -
// comparing only the outermost call's conflicts would silently drop
// whatever the intermediate merge already found and resolved.
// ============================================================
(function testAssociativity() {
  const a = [makeMember('m1')];
  const b = clone(a); b[0].allergies = 'Peanuts'; b[0].fieldVersion.allergies = a[0].fieldVersion.allergies;
  const c = clone(a); c[0].emergency = '999';     c[0].fieldVersion.emergency = a[0].fieldVersion.emergency;

  const keyOf = cf => JSON.stringify([cf.entityId, cf.field || null, cf.baseVersion]);

  const step1_ab = mergeMembers(clone(a), clone(b));
  const step2_abThenC = mergeMembers(clone(step1_ab.members), clone(c));
  // Dedupe by key before comparing - see the note above this test: the
  // same underlying disagreement can be re-derived more than once across
  // a chain (once directly, once indirectly through an already-"resolved"
  // intermediate), and design 1.4's (entityId, baseVersion) queue key is
  // exactly what collapses that back down when a real persisted queue
  // appends these. A raw concatenated list can differ in MULTIPLICITY
  // between orderings even when the deduplicated SET is identical - that
  // multiplicity difference is not a bug, so the test (and any real
  // queue-appending code) must dedupe by key, not compare raw counts.
  const abThenCKeys = Array.from(new Set(step1_ab.conflicts.concat(step2_abThenC.conflicts).map(keyOf))).sort();

  const step1_bc = mergeMembers(clone(b), clone(c));
  const step2_aThenBc = mergeMembers(clone(a), clone(step1_bc.members));
  const aThenBcKeys = Array.from(new Set(step1_bc.conflicts.concat(step2_aThenBc.conflicts).map(keyOf))).sort();

  ok('associativity: conflict keys match', deepJSON(abThenCKeys) === deepJSON(aThenBcKeys),
    `(a+b)+c=${deepJSON(abThenCKeys)}\na+(b+c)=${deepJSON(aThenBcKeys)}`);
})();

// ============================================================
// 4. Version monotonicity (corrected per design-doc note above: no
// automatic +1 during merge - see the discrepancy called out to the user)
// ============================================================
(function testVersionMonotonicity() {
  const local = [makeMember('m1', { version: 3 })];
  const remote = clone(local); remote[0].version = 7; remote[0].name = 'Remote Name';
  remote[0].fieldVersion.name = 99; // remote clearly wins this field

  const { members } = mergeMembers(clone(local), clone(remote));
  const m = members[0];
  ok('version monotonicity: member version = max(local,remote)', m.version === 7, `got ${m.version}`);
  ok('version monotonicity: winning field carries its own version', m.fieldVersion.name === 99, `got ${m.fieldVersion.name}`);
  ok('version monotonicity: never below either input', m.version >= 3 && m.version >= 7);
})();

// ============================================================
// 5. Tombstone dominance
// ============================================================
(function testTombstoneDominance() {
  const local = [makeMember('m1')];
  local[0].records[0].deletedAt = '2026-02-01T00:00:00.000Z';
  local[0].records[0].version = 5;

  const remote = clone(local);
  remote[0].records[0].deletedAt = null; // remote never saw the delete
  remote[0].records[0].version = 2;      // and is behind

  const { members } = mergeMembers(clone(local), clone(remote));
  ok('tombstone dominance: stays deleted', !!members[0].records[0].deletedAt);
})();

// ============================================================
// 6. Deterministic conflict derivation
// ============================================================
(function testDeterministicDerivation() {
  const a = [makeMember('m1')];
  const b = clone(a); b[0].name = 'Bob'; b[0].fieldVersion.name = a[0].fieldVersion.name;

  const r1 = mergeMembers(clone(a), clone(b));
  const r2 = mergeMembers(clone(a), clone(b));
  const keysOf = res => res.conflicts.map(c => JSON.stringify([c.entityId, c.field || null, c.baseVersion])).sort();
  ok('deterministic derivation: same inputs -> same conflict keys', deepJSON(keysOf(r1)) === deepJSON(keysOf(r2)));
})();

// ============================================================
// 7. Repeat-import stability (no duplicate queue entries, no content flicker)
// ============================================================
(function testRepeatImportStability() {
  const local = [makeMember('m1')];
  const remote = clone(local); remote[0].name = 'Bob'; remote[0].fieldVersion.name = local[0].fieldVersion.name;

  const first = mergeMembers(clone(local), clone(remote));
  const second = mergeMembers(clone(first.members), clone(remote));
  ok('repeat import: conflict count does not grow', first.conflicts.length === second.conflicts.length,
    `first=${first.conflicts.length} second=${second.conflicts.length}`);
  ok('repeat import: content does not flicker', deepJSON(first.members) === deepJSON(second.members));
})();

// ============================================================
// 8. Queue invalidation on local edit (simulated: bump past baseVersion,
// then re-derive - the actual "drop stale queue entries" step happens in
// the UI layer per design 1.6, not inside mergeMembers itself, so this
// test checks the PRECONDITION mergeMembers gives that layer: a fresh
// local edit's version must exceed the conflict's baseVersion.)
// ============================================================
(function testQueueInvalidationPrecondition() {
  const a = [makeMember('m1')];
  const b = clone(a); b[0].name = 'Bob'; b[0].fieldVersion.name = a[0].fieldVersion.name;
  const { members, conflicts } = mergeMembers(clone(a), clone(b));
  const conflict = conflicts.find(c => c.field === 'name');
  ok('queue invalidation precondition: conflict recorded', !!conflict);

  // simulate the user editing the field locally after the conflict (this
  // is what saveMember's bumpFieldVersions does in the real app)
  const editedMember = clone(members[0]);
  editedMember.name = 'Carol';
  editedMember.fieldVersion.name += 1;

  ok('queue invalidation precondition: new version exceeds baseVersion',
    editedMember.fieldVersion.name > conflict.baseVersion,
    `new=${editedMember.fieldVersion.name} base=${conflict.baseVersion}`);
})();

// ============================================================
// 9. Cascade suppression (conflict under a tombstoned parent never queues)
// ============================================================
(function testCascadeSuppression() {
  const local = [makeMember('m1')];
  local[0].deletedAt = '2026-02-01T00:00:00.000Z';
  local[0].version = 5;

  const remote = clone(local);
  // both sides have the member deleted (so it doesn't just "win" outright),
  // but disagree on the title of a record inside it, with the record's
  // versions tied -> would conflict if not suppressed
  remote[0].version = 5;
  remote[0].records[0].title = 'Edited elsewhere';

  const { conflicts } = mergeMembers(clone(local), clone(remote));
  const recordConflicts = conflicts.filter(c => c.path.includes('records'));
  ok('cascade suppression: no conflict under tombstoned member', recordConflicts.length === 0,
    `found: ${JSON.stringify(recordConflicts)}`);
})();

// ============================================================
// 10. Attachment merge path never consults version, only id-union + tombstone
// ============================================================
(function testAttachmentMergePath() {
  const localAtts = [{ id: 'a1', name: 'x.pdf', deletedAt: null }];
  const remoteAtts = [{ id: 'a1', name: 'x.pdf', deletedAt: '2026-01-01T00:00:00.000Z' }, { id: 'a2', name: 'y.pdf', deletedAt: null }];
  const merged = mergeAttachmentArray(localAtts, remoteAtts);
  const a1 = merged.find(a => a.id === 'a1');
  const a2 = merged.find(a => a.id === 'a2');
  ok('attachment merge: no version field involved', !('version' in a1));
  ok('attachment merge: either-side tombstone wins', !!a1.deletedAt);
  ok('attachment merge: union includes one-sided new attachment', !!a2 && !a2.deletedAt);
})();

// ============================================================
// Extra: randomized fuzz pass for idempotence + commutativity across
// small random member trees (bonus coverage beyond the 10 named tests)
// ============================================================
(function fuzz() {
  const rng = mulberry32(42);
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  for (let i = 0; i < 25; i++) {
    const base = [makeMember('m' + i)];
    const a = clone(base);
    const b = clone(base);
    // randomly mutate a and/or b
    if (rng() > 0.5) { a[0].records[0].title = 'A-' + i; a[0].records[0].version += 1; }
    if (rng() > 0.5) { b[0].records[0].title = 'B-' + i; b[0].records[0].version += 1; }
    if (rng() > 0.7) { const f = pick(['name', 'blood', 'allergies']); a[0][f] = 'A' + i; }
    if (rng() > 0.7) { const f = pick(['name', 'blood', 'allergies']); b[0][f] = 'B' + i; }

    const ab = mergeMembers(clone(a), clone(b));
    const ba = mergeMembers(clone(b), clone(a));
    const abAgain = mergeMembers(clone(ab.members), clone(b));

    ok(`fuzz[${i}]: idempotent`, deepJSON(ab.members) === deepJSON(abAgain.members));
    ok(`fuzz[${i}]: commutative conflict count`, ab.conflicts.length === ba.conflicts.length,
      `ab=${ab.conflicts.length} ba=${ba.conflicts.length}`);
  }
})();

// ============================================================
// 11. Regression: re-importing the exact same export must not manufacture
// a bloodTypeAttachment conflict just because the exported copy carries
// `.data` and the live local copy doesn't (see fieldCompareValue in
// merge-engine.js).
// ============================================================
(function testBloodTypeAttachmentNoFalseConflict() {
  const local = [makeMember('m1', {
    bloodTypeAttachment: { id: 'att1', name: 'report.jpg', type: 'image', thumb: 'data:...thumb', size: 12345 }
  })];
  // Simulate a re-import of this exact member: same attachment, but the
  // exported/incoming copy ALSO carries the raw .data field.
  const remote = clone(local);
  remote[0].bloodTypeAttachment.data = 'data:image/jpeg;base64,AAAA....';

  const { members, conflicts } = mergeMembers(clone(local), clone(remote));
  const bloodConflicts = conflicts.filter(c => c.field === 'bloodTypeAttachment');
  ok('bloodTypeAttachment: no false conflict on same-file re-import', bloodConflicts.length === 0,
    `found: ${JSON.stringify(bloodConflicts)}`);
  ok('bloodTypeAttachment: id preserved', members[0].bloodTypeAttachment.id === 'att1');

  // Sanity: a GENUINE change (different attachment id) must still conflict
  // when versions are tied.
  const remote2 = clone(local);
  remote2[0].bloodTypeAttachment = { id: 'att2', name: 'newer.jpg', type: 'image', thumb: 'data:...thumb2', size: 999 };
  const r2 = mergeMembers(clone(local), clone(remote2));
  ok('bloodTypeAttachment: genuine change still conflicts', r2.conflicts.some(c => c.field === 'bloodTypeAttachment'));
})();


// ============================================================
// 12. v48: attachment lifecycle helpers.
// (a) "Keep Both" clone must not share ANY id with the original
// (b) reference-counted "which attachment bytes are still in use"
// (c) merge -> orphaned ids = exactly what the merge killed
// ============================================================
function att(id, extra) { return Object.assign({ id, name: id + '.jpg', type: 'image', size: 10, deletedAt: null }, extra || {}); }

(function testCloneWithFreshIds() {
  const rec = makeRecord('rec1', {
    title: 'Annual checkup',
    attachments: [att('att_p1'), att('att_p2', { deletedAt: '2026-02-01T00:00:00.000Z' }), att('att_p3')]
  });
  const frozen = JSON.stringify(rec);
  let n = 0;
  const { clone: dup, attachments } = cloneWithFreshIds(rec, kind => `${kind}_new${++n}`);

  ok('clone: original untouched', JSON.stringify(rec) === frozen);
  const collectIds = (v, out) => { out = out || []; if (Array.isArray(v)) v.forEach(x => collectIds(x, out)); else if (v && typeof v === 'object') { if ('id' in v) out.push(v.id); Object.keys(v).forEach(k => collectIds(v[k], out)); } return out; };
  const oldIds = new Set(collectIds(rec)), newIds = collectIds(dup);
  ok('clone: no id shared with the original', newIds.every(id => !oldIds.has(id)), `shared: ${newIds.filter(id => oldIds.has(id))}`);
  ok('clone: all ids unique inside the clone', new Set(newIds).size === newIds.length);
  ok('clone: same number of ids as original', newIds.length === oldIds.size);
  ok('clone: attachments reported with old/new ids', attachments.length === 3 &&
    attachments.every(a => a.newId.startsWith('att_new') && a.att.id === a.newId) &&
    attachments.map(a => a.oldId).sort().join() === 'att_p1,att_p2,att_p3');
  ok('clone: non-id fields preserved', dup.title === 'Annual checkup' && dup.type === 'Checkup');
  ok('clone: tombstone on attachment preserved', dup.attachments[1].deletedAt === '2026-02-01T00:00:00.000Z');

  // references that point OUTSIDE the cloned entity are not ids and stay
  const ref = Object.assign({ id: 'rem1', recordId: 'rec1', title: 'Follow-up' }, freshMeta());
  const c2 = cloneWithFreshIds(ref, k => k + '_x').clone;
  ok('clone: recordId reference kept', c2.recordId === 'rec1' && c2.id === 'ent_x');
})();

(function testCollectLiveAttachmentIds() {
  const m = makeMember('m1', {
    bloodTypeAttachment: att('att_blood'),
    records: [
      makeRecord('r1', { attachments: [att('att_a'), att('att_dead', { deletedAt: '2026-02-01T00:00:00.000Z' })] }),
      makeRecord('r2', { attachments: [att('att_shared')] }),
      makeRecord('r3', { deletedAt: '2026-02-01T00:00:00.000Z', attachments: [att('att_in_dead_record'), att('att_shared')] })
    ]
  });
  const ids = collectLiveAttachmentIds([m]).sort();
  ok('collect: live ones found (blood type document, records)',
    ['att_a', 'att_blood', 'att_shared'].every(i => ids.includes(i)), ids.join());
  ok('collect: tombstoned attachment excluded', !ids.includes('att_dead'));
  ok('collect: attachment inside tombstoned record excluded', !ids.includes('att_in_dead_record'));
  ok('collect: id also used by a live entity still counts, listed once', ids.filter(i => i === 'att_shared').length === 1);
  ok('collect: tombstoned member excluded', collectLiveAttachmentIds([Object.assign(clone(m), { deletedAt: 'x' })]).length === 0);
  ok('orphaned: pure set difference', orphanedAttachmentIds(['a', 'b', 'c'], ['b']).join() === 'a,c');
})();

(function testMergeThenOrphans() {
  // before: 6 live attachment references, 5 distinct stored files
  const local = makeMember('m1', {
    bloodTypeAttachment: att('att_blood_old'),
    records: [
      makeRecord('r1', { attachments: [att('att_r1a'), att('att_r1b')] }),
      makeRecord('r2', { attachments: [att('att_r2')] }),
      makeRecord('r3', { attachments: [att('att_shared')] }),
      makeRecord('r4', { attachments: [att('att_shared')] })     // two records, one stored file
    ]
  });
  const before = collectLiveAttachmentIds([local]);
  ok('lifecycle: before has 5 distinct ids (shared file counted once)', before.length === 5, before.join());

  // remote: tombstones att_r1b, tombstones record r2, replaces the blood photo (higher field version),
  // tombstones r3 (r4 still uses att_shared)
  const remote = clone(local);
  remote.version = 5; remote.fieldVersion.bloodTypeAttachment = 3;
  remote.bloodTypeAttachment = att('att_blood_new');
  remote.records[0].version = 2;
  remote.records[0].attachments[1] = att('att_r1b', { deletedAt: '2026-03-01T00:00:00.000Z' });
  remote.records[1].version = 2; remote.records[1].deletedAt = '2026-03-01T00:00:00.000Z';
  remote.records[2].version = 2; remote.records[2].deletedAt = '2026-03-01T00:00:00.000Z';

  const merged = mergeMembers(clone([local]), clone([remote])).members;
  const after = collectLiveAttachmentIds(merged);
  const orphans = orphanedAttachmentIds(before, after).sort();

  ok('lifecycle: orphans are exactly what the merge killed',
    orphans.join() === 'att_blood_old,att_r1b,att_r2', orphans.join());
  ok('lifecycle: survivors not orphaned (att_r1a, att_shared)', after.includes('att_r1a') && after.includes('att_shared'));
  ok('lifecycle: shared file kept while one referencing record is still live', !orphans.includes('att_shared'));
  ok('lifecycle: new blood photo is live, not orphaned', after.includes('att_blood_new') && !orphans.includes('att_blood_new'));

  // idempotent: re-merging the same remote kills nothing more
  const again = mergeMembers(clone(merged), clone([remote])).members;
  ok('lifecycle: second import of same file orphans nothing', orphanedAttachmentIds(after, collectLiveAttachmentIds(again)).length === 0);
})();


// ============================================================
// 13. v49: collectAttachmentObjects (used to restore a deleted entity's files)
// ============================================================
(function testCollectAttachmentObjects() {
  const m = makeMember('m1', {
    bloodTypeAttachment: att('b1'),
    records: [
      makeRecord('r1', { attachments: [att('a1', { data: 'D1' }), att('a2', { deletedAt: '2026-02-01T00:00:00.000Z' })] }),
      makeRecord('r2', { attachments: [att('a3', { data: 'D3' })] })
    ]
  });
  const found = collectAttachmentObjects(m).map(a => a.id).sort();
  ok('collectAttachmentObjects: finds nested + tombstoned ones too', found.join() === 'a1,a2,a3,b1', found.join());
  ok('collectAttachmentObjects: exposes raw .data', collectAttachmentObjects(m).find(a => a.id === 'a3').data === 'D3');
  ok('collectAttachmentObjects: blood-type photo found', collectAttachmentObjects({ bloodTypeAttachment: att('b1') })[0].id === 'b1');
  ok('collectAttachmentObjects: empty for plain values', collectAttachmentObjects({ title: 'x', tags: [] }).length === 0);
})();

// ============================================================
// 14. Insurance moved out of this app (it lives in the Ledger app). The
// merge engine must never carry an `insurance` block through, even if a
// stray one is still on a member object, and must not raise conflicts
// over it.
// ============================================================
(function testInsuranceIsIgnored() {
  const local = [makeMember('m1')];
  const remote = clone(local);
  remote[0].insurance = { policies: [{ id: 'pol1', provider: 'Acme', version: 9, deletedAt: null }], claims: [] };
  local[0].insurance = { policies: [{ id: 'pol1', provider: 'Other', version: 9, deletedAt: null }], claims: [] };

  const res = mergeMembers(clone(local), clone(remote));
  ok('insurance: not part of the merged member', !('insurance' in res.members[0]));
  ok('insurance: differences never raise conflicts', res.conflicts.length === 0, JSON.stringify(res.conflicts));
  ok('insurance: nothing else on the member is lost',
    res.members[0].records.length === local[0].records.length && res.members[0].name === local[0].name);
})();


// ============================================================
// 15. Daily Plan (v62): plan items, intake log, monthly summaries, settings
// ============================================================
(function testDailyPlan() {
  function item(id, o) {
    return Object.assign({ id, kind: 'supplement', name: 'Vitamin D', dose: '1000 IU', meal: 'after',
      schedule: { mode: 'slots', slots: ['morning'] }, time: '', icon: '💊', color: 'teal', note: '',
      order: 1, startDate: '2026-10-01', endDate: '', archivedRecordId: null }, freshMeta(), o || {});
  }
  function intake(itemId, date, slot, o) {
    return Object.assign({ id: `${itemId}_${date}_${slot}`, itemId, date, slot, status: 'taken',
      takenAt: `${date}T08:00:00.000Z` }, freshMeta(), o || {});
  }
  const byId = arr => arr.slice().sort((a, b) => (a.id < b.id ? -1 : 1));

  // --- members without the feature are untouched
  {
    const l = [makeMember('m1')], r = clone(l);
    const res = mergeMembers(clone(l), clone(r));
    ok('plan: members without plan data gain no plan keys',
      !('planItems' in res.members[0]) && !('intakeLog' in res.members[0]) && !('planSettings' in res.members[0]));
  }

  // --- plan items: union, version wins, tie conflict, order is cosmetic
  {
    const l = [makeMember('m1', { planItems: [item('pA'), item('pB', { name: 'Zinc' })] })];
    const r = clone(l);
    r[0].planItems.push(item('pC', { name: 'Omega-3' }));
    r[0].planItems[0].name = 'Vitamin D3'; r[0].planItems[0].version = 2;
    const res = mergeMembers(clone(l), clone(r));
    const names = res.members[0].planItems.map(i => i.name).sort();
    ok('plan: union of items + higher version wins', JSON.stringify(names) === JSON.stringify(['Omega-3', 'Vitamin D3', 'Zinc']), JSON.stringify(names));
    ok('plan: no conflicts for clean one-sided edits', res.conflicts.length === 0);
  }
  {
    const l = [makeMember('m1', { planItems: [item('pA')] })];
    const r = clone(l);
    r[0].planItems[0].order = 7;                 // cosmetic only
    ok('plan: order-only difference is not a conflict', mergeMembers(clone(l), clone(r)).conflicts.length === 0);
    r[0].planItems[0].dose = '2000 IU';          // same version, different content
    const res = mergeMembers(clone(l), clone(r));
    ok('plan: same-version content difference IS a conflict', res.conflicts.length === 1 && res.conflicts[0].path[1] === 'planItems');
    ok('plan: conflict keeps local content', res.members[0].planItems[0].dose === '1000 IU');
  }

  // --- intake log: same dose logged on both devices => ONE entry, no conflict, symmetric
  {
    const a = [intake('pA', '2026-10-14', 'morning', { takenAt: '2026-10-14T00:12:00.000Z' })];
    const b = [intake('pA', '2026-10-14', 'morning', { takenAt: '2026-10-14T00:05:00.000Z' })];
    const lm = [makeMember('m1', { intakeLog: a })], rm = [makeMember('m1', { intakeLog: b })];
    rm[0].id = lm[0].id;
    const r1 = mergeMembers(clone(lm), clone(rm)), r2 = mergeMembers(clone(rm), clone(lm));
    ok('intake: double-logged dose merges to one entry', r1.members[0].intakeLog.length === 1);
    ok('intake: no conflict for double-logged dose', r1.conflicts.length === 0 && r2.conflicts.length === 0);
    ok('intake: merge is symmetric', JSON.stringify(byId(r1.members[0].intakeLog)) === JSON.stringify(byId(r2.members[0].intakeLog)));
    ok('intake: tie keeps the earlier takenAt', r1.members[0].intakeLog[0].takenAt === '2026-10-14T00:05:00.000Z');
  }
  // taken vs skipped on a tie: taken wins, both directions
  {
    const t = intake('pA', '2026-10-14', 'evening'), k = intake('pA', '2026-10-14', 'evening', { status: 'skipped', takenAt: null });
    const x = mergeIntakeLog([t], [k]), y = mergeIntakeLog([k], [t]);
    ok('intake: taken beats skipped on a version tie (both orders)', x[0].status === 'taken' && y[0].status === 'taken');
  }
  // undo (tombstone, higher version) beats an older "taken"; a re-take beats the undo
  {
    const taken = intake('pA', '2026-10-14', 'morning');
    const undone = Object.assign({}, taken, { deletedAt: '2026-10-14T01:00:00.000Z', version: 2 });
    const retaken = Object.assign({}, taken, { deletedAt: null, version: 3 });
    ok('intake: undo (v2) beats taken (v1)', mergeIntakeLog([taken], [undone])[0].deletedAt !== null);
    ok('intake: re-take (v3) beats undo (v2)', mergeIntakeLog([undone], [retaken])[0].deletedAt === null);
  }
  // as-needed entries (random ids) from two devices are both kept
  {
    const a = [Object.assign({ id: 'in1', itemId: 'pX', date: '2026-10-14', slot: null, status: 'taken', takenAt: '2026-10-14T02:00:00.000Z' }, freshMeta())];
    const b = [Object.assign({ id: 'in2', itemId: 'pX', date: '2026-10-14', slot: null, status: 'taken', takenAt: '2026-10-14T08:00:00.000Z' }, freshMeta())];
    ok('intake: as-needed doses from two devices are both kept', mergeIntakeLog(a, b).length === 2);
  }

  // --- cutoff: whole-month rule
  ok('cutoff: monthEndStr', monthEndStr('2026-02-10') === '2026-02-28' && monthEndStr('2028-02-10') === '2028-02-29' && monthEndStr('2026-12-01') === '2026-12-31');
  ok('cutoff: month fully before cutoff is compacted', isCompactedDate('2026-07-15', '2026-08-01') === true);
  ok('cutoff: month straddling the cutoff is kept', isCompactedDate('2026-07-15', '2026-07-31') === false);
  ok('cutoff: no cutoff => nothing compacted', isCompactedDate('2020-01-01', undefined) === false);
  {
    const old = intake('pA', '2026-06-10', 'morning'), edge = intake('pA', '2026-07-05', 'morning'), cur = intake('pA', '2026-10-14', 'morning');
    const out = mergeIntakeLog([old, edge], [cur], '2026-07-20');
    const ids = out.map(e => e.date).sort();
    ok('cutoff: old detail cannot be resurrected by a merge', JSON.stringify(ids) === JSON.stringify(['2026-07-05', '2026-10-14']), JSON.stringify(ids));
  }

  // --- summaries: grow-only max, idempotent, symmetric
  {
    const a = [{ id: 'pA_2026-06', itemId: 'pA', month: '2026-06', taken: 20, skipped: 1, expected: 30 }];
    const b = [{ id: 'pA_2026-06', itemId: 'pA', month: '2026-06', taken: 25, skipped: 0, expected: 30 },
               { id: 'pA_2026-05', itemId: 'pA', month: '2026-05', taken: 10, skipped: 0, expected: null }];
    const x = mergeIntakeSummaries(a, b), y = mergeIntakeSummaries(b, a), z = mergeIntakeSummaries(x, b);
    const jun = x.find(s => s.month === '2026-06');
    ok('summaries: per-field max', jun.taken === 25 && jun.skipped === 1 && jun.expected === 30);
    ok('summaries: symmetric', JSON.stringify(byId(x)) === JSON.stringify(byId(y)));
    ok('summaries: idempotent (re-merging changes nothing)', JSON.stringify(byId(x)) === JSON.stringify(byId(z)));
    ok('summaries: union of months', x.length === 2);
  }

  // --- plan settings: higher version wins; tie keeps local, never a conflict
  {
    const l = [makeMember('m1', { planSettings: { version: 1, slotTimes: { morning: '07:00' } } })];
    const r = [makeMember('m1', { planSettings: { version: 2, slotTimes: { morning: '09:00' } } })];
    const res = mergeMembers(clone(l), clone(r));
    ok('settings: higher version wins', res.members[0].planSettings.slotTimes.morning === '09:00');
    r[0].planSettings.version = 1;
    const tie = mergeMembers(clone(l), clone(r));
    ok('settings: tie keeps local, no conflict', tie.members[0].planSettings.slotTimes.morning === '07:00' && tie.conflicts.length === 0);
  }

  // --- full-member cutoff wiring through mergeMembers opts
  {
    const lm = [makeMember('m1', { intakeLog: [intake('pA', '2026-03-01', 'morning')] })];
    const rm = [makeMember('m1', { intakeLog: [intake('pA', '2026-10-14', 'morning')] })];
    const res = mergeMembers(clone(lm), clone(rm), { intakeCutoff: '2026-07-16' });
    ok('mergeMembers: opts.intakeCutoff is honoured', res.members[0].intakeLog.length === 1 && res.members[0].intakeLog[0].date === '2026-10-14');
    const noCut = mergeMembers(clone(lm), clone(rm));
    ok('mergeMembers: without opts nothing is pruned', noCut.members[0].intakeLog.length === 2);
  }
})();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
