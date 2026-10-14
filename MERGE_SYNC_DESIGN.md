# Family Health Shield — Field/Array-Level Merge Sync

> **Note (v53):** this app was renamed from *Family Health & Shield* to *My Health* and its
> insurance module was removed (insurance now lives in the Ledger app). Sections of this document
> that describe `insurance.policies`, ledger rows, riders, coverages, sumInsuredHistory,
> surrenderRecords or claims are kept for history only: the merge engine no longer implements them,
> and imports ignore any `insurance` block.


Design doc, finalized before implementation. Two sections, kept physically
separate on purpose: **Semantics** is for whoever (including future-you) needs
to understand *why* the system behaves a certain way. **Mechanics** is for
whoever is about to write or modify the code.

> **Status (v49, 2026-10-02):** implemented in v32 – v39 and amended through
> v49. The original design text is kept as written; later findings are added
> as marked notes ("**Update vNN**") next to the section they change, and
> collected in the *Amendments since the first implementation* table at the
> end. Where an older paragraph and an update disagree, the update wins.

---

## Part 1 — Semantics (read this before touching behavior)

### 1.1 What "version" means

`version` is a **Lamport logical clock**, not a timestamp. It answers "how
much history has this entity seen?", not "when was this last touched."

- Local edit: `version += 1`
- Merge: `version = max(local.version, remote.version) + 1`
- `updatedAt` (wall-clock) is stored too, but **only for display** ("last
  edited on…"). It never participates in conflict resolution.

**Consequence, stated explicitly so it isn't mistaken for a bug:** a device
that has been offline for a long time will have a *lower* version than a
device that has been syncing regularly, even if the offline device's edit is
chronologically more recent. In a version-equal-or-lower conflict, the
offline edit can lose. This is intentional — an edit made against a stale
base losing is safer than it silently overwriting everything the other side
accumulated in the meantime.

### 1.2 What counts as a conflict

`version` equal on both sides **and** content differs → conflict, always
routed to the conflict queue. No automatic tie-break of any kind, including
by `deviceId`.

This one rule also resolves first-time migration: all pre-existing data
gets `version = 1` on upgrade, and any old export file that predates the
`version` field is treated as `version = 1` on import. Two `version = 1`
copies with different content simply produce a conflict — unknown-provenance
data is never auto-resolved, it's queued for a human to look at.

### 1.3 `deviceId` does not adjudicate anything

`deviceId` is provenance and debugging only ("device A resolved this"). It
is **not** used as a tie-breaker, because there is no tie to break —
version-equal conflicts always queue, never auto-resolve.

Conflict queue entries don't need a `deviceId` for identity either. The key
is `(entityId, baseVersion)` — deterministic, so two devices that
independently derive the same conflict produce the same queue entry.

### 1.4 The conflict queue is derived state, not a synced entity

Do not invent a "conflict record" data type that gets exported/imported.
The queue is recomputed locally from `(local entity, remote entity)` on every
merge. A resolution is just a normal edit — it produces a new `version`
and flows through the exact same sync path as any other change. This keeps
the sync protocol to one kind of event ("an entity changed version") instead
of two.

### 1.5 Conflict-output contract (binding on the merge function)

**For any field/entity that goes into the conflict queue, the merge
function's output keeps the local content. The remote content is stored
only in the queue entry, never applied to the live data.**

This is a correctness requirement, not a UI preference — idempotence and
determinism depend on it. If the merge function picked a side arbitrarily
for queued conflicts, re-importing the same file, or importing A→B vs B→A,
would show different content and could re-trigger the queue differently
each time.

Because of this contract, "show local version + a pending-conflict badge,
don't block browsing" (the UI behavior) falls out for free — it's just
what the contract already produces, not a separate decision.

**Edge case this implies:** if the user keeps editing a field while a
conflict on it is still pending, the new edit produces a higher version,
which triggers the queue invalidation rule (1.6) and the pending remote
edit is silently dropped. This is the LWW semantics working as designed —
but it means "ignore the conflict and keep editing" is equivalent to
unilaterally deciding against the other side's edit. That needs to be
surfaced to the user somehow (copy/tooltip), not just buried in code
comments.

### 1.6 Conflict queue invalidation

A queue entry becomes stale once the local entity's version has moved past
the entry's `baseVersion` (via a new local edit, or via importing someone
else's resolution). Stale entries are dropped, not shown. Without this
rule, an already-resolved conflict reappears on every subsequent sync,
and a stale re-resolution can stomp on a resolution someone else already
made.

**Expected (not exceptional) event:** two devices can resolve the same
conflict differently before syncing with each other. That produces two
different contents at the same version — which is, correctly, a *new*
conflict ("conflict between two resolutions"). This is working as intended;
the user resolves it again.

### 1.7 Nested entities (insurance.policies → ledger/rider/coverage/
sumInsuredHistory/attachments, records, etc.)

Two lifecycle rules that don't exist for top-level arrays:

- **Tombstone dominance cascades down.** If any ancestor in an entity's
  chain is tombstoned, that entity is excluded from conflict detection and
  the queue entirely. (A conflict on a line item of a deleted policy is
  meaningless to show a user.) "Keep both" resolutions that duplicate an
  entity must deep-copy the *entire* subtree with fresh ids at every level
  — `sanitizeIdsDeep` already does deep-id remapping and should be reused,
  but confirm it performs a true deep clone, not a shallow one, before
  relying on it here.
  **Update v48 — this assumption was wrong.** `sanitizeIdsDeep` only
  replaces ids that fail the safe-id pattern; a valid id survives it. A
  "keep both" copy built on it kept the original's entity id (two entries
  with one id in one array) and the original's attachment ids (two entities
  sharing one set of stored files). Keep Both now uses
  `FHSMerge.cloneWithFreshIds` (2.9), which gives **every** id in the copy a
  new one: the entity, every nested entity, every attachment. Ids that
  point *outside* the copied entity (a claim's `policyId` / `coverageId`)
  are references, not ids, and are kept.
- **Child edits never bump a parent's version.** A ledger row's version
  tracks only that ledger row. Editing a ledger row does not touch its
  parent policy's version. If it did, independent edits to different
  ledger rows under the same policy would produce spurious parent-level
  conflicts, defeating the point of tracking ledger rows independently.
  Containment only affects deletion cascade (1.7a), never version counting.

Tombstones being kept forever (1.8) means a child can always resolve its
parent reference — no "orphaned record because the parent was physically
cleaned up" case to handle.

### 1.8 Tombstones are permanent

No automatic physical cleanup. In a serverless, file-based sync model there
is no way to know every device has received a given delete — an old device
that syncs once a year would resurrect anything cleaned up in the meantime.
Tombstone records are small (a handful of fields); keeping them forever is
cheap. If cleanup is ever needed, it requires a manual, explicit rule
("older than N days AND every known device has synced past it"), which
needs per-device last-synced tracking this design does not currently build.

### 1.9 Attachments are a simplified case

Binary attachment content is immutable once uploaded — there's no "edit,"
only "add" and "delete." So attachments use **id + tombstone only**, no
`version`: both sides have it → keep; only one side has it, not deleted →
keep; one side tombstoned it → tombstoned.

**Precondition, confirmed against the current code:** this only holds
because attachment objects (`id / name / path / type / thumb / size / data`)
have no field that's edited after upload — `name` is fixed at upload time,
there's no caption/tag/description field. If such a field is ever added,
*that field* needs its own `version`; the binary blob itself still doesn't.

**Tolerated inconsistency:** a record can reference an attachment id that
hasn't arrived yet in this device's copy (the file is in an export that
hasn't been synced here yet). Not handled specially — tombstone permanence
+ union merge guarantees it eventually arrives. Documented here so it
isn't "fixed" as a bug later.

**Not deduplicated:** if both sides independently upload a different photo
to the same record, both survive the merge as separate attachments. Mild
UI redundancy, no data loss — not worth building dedup for.

**Update v40 — the blood-type photo is the exception to "id + tombstone".**
`bloodTypeAttachment` is a single object, not an array, so it is a member
**scalar field** (listed in `MEMBER_SCALAR_FIELDS`) with its own
`fieldVersion`. Replacing or clearing it bumps that entry; the higher
version wins on merge, a tie queues a field conflict. It has no tombstone
because it does not need one: "removed" is just the field being `null` at a
higher version. For the equality check the raw `.data` is stripped from both
sides (`fieldCompareValue`), because an exported copy carries `.data` and the
live local copy does not; without that, re-importing the same file raised a
false conflict.

**Update v48/v49 — stored bytes are local, and their lifecycle is managed.**
The attachment *metadata* syncs; the *bytes* (IndexedDB, encrypted when
encryption is on) never do — they travel inside export files as `.data` and
are re-stored on import. That makes "when may a local file be deleted?" a
separate question from "which attachment objects exist?" The rule (2.9): a
file is in use as long as at least one attachment object that is not
tombstoned, inside an entity that is not tombstoned, points at its id. After
any operation that can change that (merge import, conflict resolution,
whole-replace import) the files the operation freed are deleted, after the
change has been saved, and only those (a differential, never a global
sweep).

### 1.10 `history` / `notes` (free-text fields)

Modeled from day one as an **append-only array of `{id, version, text,
deletedAt}` entries**, even though the v1 UI only exposes single-block
editing (equivalent to LWW on the latest entry). Existing free text is
migrated into one entry per field.

Chosen as the default without waiting on real-world usage confirmation,
because it doesn't cost anything either way: if it turns out only one
person ever edits these fields, nothing is lost by having the entry-array
plumbing sit unused under a single-entry UI. If it turns out multiple
people do append to the same field, the fix is adding an "append a new
entry" UI affordance — not migrating flat timestamped text into entries
retroactively, which is the genuinely painful direction.

### 1.11 Correctness argument (for the property tests in 2.4)

The merge output is, at its core, a union of all known versions plus a
derived conflict queue — as long as no step auto-picks a winner for a
version-equal conflict, this union is commutative, associative, and
idempotent **for the conflict queue's contents**: any order of merging
three devices' files produces the same set of queue entries.

This does *not* claim the materialized data itself is order-independent —
which entity's queued conflict shows which content is deliberately
local-biased (1.5), so it differs depending on which device you're standing
on. What's guaranteed order-independent instead is: (a) the queue contents,
and (b) the final data *once every queued conflict has actually been
resolved*, because a resolution is just a normal version-bumping edit that
flows through the same, already-proven-commutative merge path.

### 1.12 Delete vs edit (added v49)

One device deletes an entity while the other edits it, both landing on the
same `version`: that is a tie with different content, so it is queued like
any other conflict (1.2) — nothing is auto-resolved, including in favour of
the delete.

**What "their version" means must include "deleted".** `deletedAt` is not
one of the compared scalar keys (it is sync metadata), so the conflict
entry's remote side may be a tombstone that otherwise looks like an ordinary
edit. Rules:

- The conflict screen labels a deleted side "Deleted — …".
- **Keep Mine** — unchanged: settle the tie by bumping the version.
- **Keep Theirs** — adopts the other side's deleted state together with its
  fields. Deleted there → deleted here (and its stored files are freed).
  Deleted here, edited there → the entity comes back, and its files are put
  back into IndexedDB from the raw `.data` that came with the import.
  (v48 and earlier copied only the scalar fields, so a "keep theirs" on a
  deletion did not delete and on an edit did not restore.)
- **Keep Both** is not offered when their side is the deleted one: a copy of
  a tombstone would be an invisible duplicate. When *this* side is the
  deleted one and theirs is live, Keep Both is allowed: it restores their
  edit as a new entity and leaves the local deletion in place.

Known limit: restoring a deleted entity can only bring back files whose raw
`.data` is in the import. An attachment that arrived without `.data` (its
bytes never left the other device's browser) is restored as metadata only.

---

## Part 2 — Mechanics

### 2.1 Fields added to every syncable entity

Applies recursively to: `member`, `record`, `customReminder`,
`insurance.policies[]`, and everything nested under a policy that
`sanitizeIdsDeep` currently walks (`ledger[]`, riders, `coverages[]`,
`sumInsuredHistory[]`, `surrenderRecords[]`). Attachments get a reduced set
(2.2).

```
id            (existing)
version       int, starts at 1, max(local, remote)+1 on merge
updatedAt     ISO string, wall-clock, display only — never read by merge logic
deletedAt     ISO string | null — tombstone marker
schemaVersion int — for future field-shape migrations
```

`member` additionally gets:

```
fieldVersion: { name: 1, nameZh: 1, birth: 1, blood: 1, height: 1,
                allergies: 1, emergency: 1, gender: 1, ... }
```
One entry per top-level scalar field (the list the code uses is
`MEMBER_SCALAR_FIELDS`: `name`, `nameZh`, `nameZhAvatarIdx`, `gender`,
`birth`, `blood`, `height`, `allergies`, `emergency`, and — since v40 —
`bloodTypeAttachment`). **Editing a field bumps only that
field's entry.** Add a lint/test that diffs which fields actually changed
after a mutation and asserts only those `fieldVersion` entries moved — a
setter that bumps everything collapses per-field tracking back down to
member-level LWW silently.

`history` / `notes` become:
```
history: [{ id, version, text, deletedAt, schemaVersion }]
```

### 2.2 Attachments (reduced field set — see 1.9)

```
id
deletedAt
```
No `version`, no `fieldVersion`. Merge rule: union by id; either side's
`deletedAt` wins (tombstone dominance for a leaf entity, trivially).

### 2.3 Device identity

A `deviceId` (UUID, generated once, stored locally, never regenerated) is
required for provenance/debugging and for conflict-entry attribution in the
UI. Not used in any resolution logic (1.3).

### 2.4 Merge function

Pure function: `merge(localMembers, remoteMembers) → { members, conflicts }`.
No I/O, no DOM, no `confirm()` — those stay in the import flow that calls it.
**Implemented as `FHSMerge.mergeMembers()` in `merge-engine.js`** (a
standalone file, not inside app.js's DOM-heavy scope — wrapped in a UMD
factory so it dual-loads as a plain `<script>` in the browser, exposing
only the single namespaced `FHSMerge` global, and as a CommonJS module for
`merge-engine.test.js` under Node. The UMD wrapper was added after
discovering `app.js` already declares a few of the same short names
— `MEMBER_SCALAR_FIELDS`, `freshFieldVersions` — for its own local-editing
needs; two top-level `const` declarations of the same name across separate
`<script>` tags in one page throw a SyntaxError and take the whole app
down, not just misbehave, so nothing in this file is a bare global.)

**Correction found during implementation, superseding a line in this
section as originally written:** this section's test list originally said
"version after merge always equals max(local, remote) + 1". That directly
contradicts idempotence (test 1 below) — bumping on every merge means
re-importing the same file twice produces a different result each time.
Tracing through 1.4 and 1.6, the "+1" is meant to happen when a *person*
resolves a conflict — that resolution is just a normal edit through the
existing `bumpVersion()` path, not something the merge algorithm itself
does. The implemented (and tested) rule is: `mergeMembers` never bumps
version on its own; it only ever picks the higher of the two input
versions (or keeps local's, unchanged, on a tie/conflict per 1.5). The
"+1" happens later, naturally, whenever the conflict is actually resolved
through the ordinary edit path.

**Second finding from implementation, worth documenting since it isn't a
bug and someone will otherwise "fix" it:** the same underlying disagreement
can be *re-derived* more than once across a chain of merges — e.g. device A
merges with B (finds and locally-resolves a conflict), then merges with C;
separately, B merges with C first (independently re-finding the same
disagreement), then A merges with that result and finds it *again*. The
raw list of conflicts across a merge chain can therefore have different
*multiplicity* depending on order, even though the *set* of unique
`(entityId, baseVersion[, field])` keys is identical — which is exactly
what 1.4's "the queue is derived state, keyed by (entityId, baseVersion)"
already handles: whatever persists the real queue must dedupe by that key
when appending a merge's conflicts, not append raw. `mergeMembers` itself
is correct as tested; this is a requirement on its caller (step 4).

Test suite, as actually implemented in `merge-engine.test.js` (**94**
assertions passing as of v49, including a 25-iteration seeded fuzz pass beyond
the 10 named cases below; v40 added the blood-type no-false-conflict cases,
v48/v49 added the attachment-lifecycle cases listed in 2.9):

1. **Idempotence** — merging the same remote file twice produces the same
   result as merging it once.
2. **Commutativity** — `merge(A, B)` and `merge(B, A)` produce the same
   conflict queue contents (see 1.11 for the precise claim).
3. **Associativity** — `merge(merge(A,B), C)` and `merge(A, merge(B,C))`
   produce the same conflict queue contents.
4. **Version monotonicity** — `version` after merge always equals
   `max(local, remote) + 1` when content differs, and is never lower than
   either input.
5. **Tombstone dominance** — an entity tombstoned locally is never revived
   by importing a remote copy with a lower or equal version that lacks the
   tombstone.
6. **Deterministic conflict derivation** — two independent merges of the
   same `(local, remote)` pair produce identical `(entityId, baseVersion)`
   queue keys.
7. **Repeat-import stability** — importing the same file twice in a row
   produces no duplicate queue entries and no content flicker.
8. **Queue invalidation on local edit** — editing a field with a pending
   conflict clears that queue entry and the remote suggestion is dropped
   (matches 1.5's edge case).
9. **Cascade suppression** — a conflict on a child of a tombstoned parent
   never appears in the queue.
10. **Attachment merge path** — attachment merge never consults `version`,
    only id-union + tombstone.

### 2.5 Deletion

UI delete actions write `deletedAt`; nothing is spliced out of arrays.
Every list/detail view filters `deletedAt != null` at render time. Edit
entry points (form open, inline edit) must check `deletedAt` and refuse —
otherwise a user can edit their own tombstoned entity and create a
self-inflicted conflict.

**Update v48 — stored files.** A direct delete (record, member, ...) writes
the tombstone, saves, and deletes the entity's stored files right away; the
tombstone keeps only metadata. Deletions that arrive through a merge or a
conflict resolution free their files through the same reference-counted
purge (2.9).

### 2.6 Import flow changes

`normalizeImportedMembers` gains: missing `version` → treat as `1`; missing
`schemaVersion` → treat as `0` (pre-migration). `mergeImportedMembers` is
rewritten to call the pure `merge()` function, apply the result, persist any
new conflict-queue entries, and only then trigger the existing
`migrateMemberAttachmentsToIdb` / `saveData` path.

**Update v48/v49 — file cleanup around the import.** `mergeImportedMembers`
records which attachment ids the member was using before the merge; after a
**successful** `saveData()` it deletes those that no member uses any more
(`purgeUnreferencedAttachmentBytes`). If `saveData()` fails, `members` is
restored and the bytes that `migrateMemberAttachmentsToIdb` had just stored
for data that was never committed are deleted. The whole-replace import
("Export All") does the same before/after comparison across all members.

### 2.7 Conflict queue UI (v1) — implemented in build order step 5

Simple list, one row per pending conflict: member name, a human label
(field name or entity type), a short one-line summary of "your version"
vs "their version" (no inline diffing), and action buttons — "Keep Mine" /
"Keep Theirs" always, "Keep Both" only for array-item entities (not a
single scalar field, where "both" has no meaning). Entity display uses the
tombstone-cascade-suppression rule from 1.7, so a conflict under a deleted
parent never renders — enforced by `getActiveConflicts()` pruning the
persisted queue on every render, which also drops entries whose local
version has already moved past `baseVersion` (1.6's invalidation rule) and
entries whose entity/member no longer exists at all.

**A gap found while implementing "keep both":** the conflict entries
`mergeSyncArray` originally pushed only carried the *scalarKeys-projected*
comparison fields, not the full entity — insufficient for "keep both" to
reconstruct a real duplicate (it would be missing attachments and other
un-projected fields). Fixed in `merge-engine.js` to store the full `local`/
`remote` objects; the projected versions are still used for the equality
check itself, just not for what's stored.

**A second wrinkle found while implementing "keep remote"/"keep both" for
container entities:** a policy/coverage/record/ledger/surrenderRecords
conflict's `remote` object is the *raw, pre-child-merge* remote input —
blindly `Object.assign`-ing it onto the live (already correctly
child-merged) entity would discard the children's careful merge work
(e.g. overwrite a policy's already-merged `ledger`/`coverages` array with
remote's unmerged one). Resolution for these types only copies the
disputed *scalar* fields (the same `scalarKeys` lists `merge-engine.js`
itself exports — reused directly from `FHSMerge.RECORD_SCALAR_KEYS` etc.
so the two can't drift apart), leaving the live entity's already-merged
children untouched. Leaf types with no nested children (riders,
sumInsuredHistory, historyEntries, claims) get a safe full-object apply.

**Resolution always bumps version, even "Keep Mine"/no content change:**
per 1.4 a resolution is a normal edit, and the whole point of resolving is
that the tie shouldn't resurface on the next sync with a device that still
has the old value on either side. If content doesn't change but version
doesn't move either, the next merge against a stale copy would just
re-detect the identical tie. So every resolution path — even one that
doesn't touch content — calls `bumpVersion()` on the entity (or bumps the
specific `fieldVersion[f]` entry for a field conflict) to settle it.

**Update v48/v49 — what each choice does now.**

- *Keep Both* builds the copy with `FHSMerge.cloneWithFreshIds` (fresh id for
  the entity, all nested entities, all attachments), writes the attachment
  bytes under the new ids first (from the queued `.data`, else copied from the
  local copy under the old id), then inserts the copy and settles the
  original. If the save fails the copy is removed again and the new bytes
  deleted. Unlock is requested first when encryption is on; declining it
  changes nothing and leaves the conflict queued. Not offered when the other
  side is deleted (1.12).
- *Keep Theirs* on a field conflict for `bloodTypeAttachment`: the queued
  remote object still carries the export's raw `.data` and an id from another
  browser, so it is first stored through `persistAttachmentsToIdb` (new local
  id, bytes in IndexedDB, no inline `.data` in `localStorage`); the replaced
  photo's bytes are freed after the save.
- *Keep Theirs* on an array-item conflict also adopts the deleted state (1.12).
- After every choice, the files the choice freed are deleted (reference
  counted, after the save).
- `resolveConflict` is asynchronous and ignores a second click while one
  resolution is still running, so a double-click cannot create two copies.

The queue itself lives in its own `localStorage` key
(`family_health_tracker_v3_conflicts`), separate from `STORAGE_KEY` — it
is derived/local-only state and must never be exported, imported, or
otherwise synced (1.4), which the implementation respects by keeping it
completely outside the `members` array and the export/import code paths.


### 2.8 Migration (existing installs, first launch after upgrade)

All current data: `version = 1`, `schemaVersion` set to current,
`deletedAt = null`, `fieldVersion` initialized to `1` for every scalar
field, existing `history`/`notes` text wrapped into a single entry. No
special-casing needed for old *export files* imported after upgrade —
2.6's "missing version → 1" rule already covers them, and produces the
correct "queue it, don't guess" outcome per 1.2.

**Release note to include:** recommend syncing all devices once
immediately after upgrading, before making further edits, to minimize the
number of conflicts generated by stale offline data meeting the new
version scheme for the first time.

### 2.9 Attachment byte lifecycle (added v48/v49)

Pure helpers in `merge-engine.js` (no DOM, no IndexedDB, no randomness — ids
come from the caller), exported on `FHSMerge`:

| Function | What it decides |
| --- | --- |
| `cloneWithFreshIds(value, genId)` | Deep clone with a new id on every `id`; returns `{ clone, attachments: [{oldId, newId, att}] }` so the caller can copy bytes. `genId('att' \| 'ent')`. |
| `collectLiveAttachmentIds(value)` | Ids of attachments in use anywhere inside `value`: neither the attachment nor any containing entity has `deletedAt`; also covers `bloodTypeAttachment`. One id used in several places is listed once. |
| `collectAttachmentObjects(value)` | Every attachment object (tombstoned or not) inside `value`, including raw `.data`; used to restore a deleted entity's files. |
| `orphanedAttachmentIds(before, after)` | `before − after`: what an operation freed. |

`app.js` does the actual byte work:

- `purgeUnreferencedAttachmentBytes(candidateIds)` — deletes the candidates
  that `collectLiveAttachmentIds(members)` (all members) does not contain.
- `restoreAttachmentBytes(remoteEntity, liveEntity)` — puts back missing
  bytes for a restored entity from the import's `.data`.
- Callers: `mergeImportedMembers` (candidates = this member's ids from before
  the merge), `resolveConflict` (candidates = all ids in use before the
  choice), whole-replace import (candidates = all ids before).

**Design decisions, with the reasoning, so they are not "improved" later:**

1. **Reference counted, not "delete what the operation removed".** Two
   entities can legitimately point at one stored file (older data, or any
   future bug), so deleting by difference alone could remove a file that is
   still in use. Counting live references makes that impossible.
2. **Differential, not a global sweep.** Only ids the operation itself could
   have freed are candidates, so a file the operation never touched (for
   example one being added in an open form) is never proposed.
3. **After a successful save, never before.** There is no undo for a merge;
   the only revert is restoring the previous `members` when `saveData()`
   fails. Deleting only after the save means that revert never leaves a
   hole.
4. **No delayed ("trash then 7 days") deletion.** With 1 and 3 in place it
   would only keep orphans longer.
5. **Tombstones count as "not in use".** They stay in the data forever for
   sync (1.8), but their bytes are not needed; direct deletes already worked
   this way.

**Not covered:** no periodic full-database orphan scan (cleanup runs only on
the merge, conflict-resolution and whole-replace paths); if a save fails
right after a restore of a deleted entity's files, those files can stay as
orphans (storage only); `historyEntries` is still shadow data — the plain
`history` text is what screens and reports read — until multi-editor notes
become real.

**Tests (merge-engine.test.js):** a Keep Both clone shares no id with the
original; the old/new attachment id mapping; live-id collection (tombstoned
attachment, tombstoned record, blood-type photo, ledger / surrender
attachments, a shared id counted once); a real `mergeMembers` run whose
orphan set is exactly what the merge killed and keeps a shared file while one
referencing record is still live; a second import of the same file orphans
nothing; `collectAttachmentObjects`. The browser-only paths (`resolveConflict`,
the import flow, the screen) are exercised with a Chromium script against the
real `app.js`, not by the Node tests: merge cleanup, Keep Both (record and
policy with nested ledger / attachments), Keep Theirs (blood-type photo,
policy), delete-vs-edit in both directions with and without photos, a
conflict whose entity is deleted afterwards, double-click, repeat import,
whole-replace cleanup.

---

## Amendments since the first implementation

| Version | Change | Section |
| --- | --- | --- |
| v32 – v39 | Data layer, tombstones, `mergeMembers`, import wiring, conflict screen | build order 1 – 6 |
| v40 | `bloodTypeAttachment` compared without `.data`; documented as a scalar field | 1.9 |
| v48 | Keep Both makes an independent copy (`cloneWithFreshIds`); merge and Keep Theirs on the blood-type photo free replaced bytes (reference counted, after save) | 1.7, 1.9, 2.6, 2.7, 2.9 |
| v49 | Delete-vs-edit: Keep Theirs adopts deleted state, deleted side labelled, no Keep Both on a deleted side; whole-replace import frees replaced files; `collectAttachmentObjects` | 1.12, 2.6, 2.7, 2.9 |

---

## Build order

1. Data layer: fields above, on every entity, recursively through
   `insurance`. `deviceId` generation. Confirm `sanitizeIdsDeep` deep-clones.
2. Deletion → tombstone instead of splice; edit-blocked-on-tombstone checks.
3. Pure `merge()` function + the 10 property tests in 2.4, written before
   wiring anything up.
4. Wire into `importData` / `mergeImportedMembers`.
5. Conflict queue UI (simple list per 2.7).
6. Migration step (2.8) + README/release note update.

**Status:** steps 1 – 6 done (v32 – v39); later amendments in the table
above. The v40 – v49 findings came from testing, not from the original plan.

Existing full-family-backup import (`exportType: 'all'`, whole-array
replace) is still a whole replace and does no merging — this design only
changes the single-member merge path. Since v49 it does clean up the stored
files of the data it replaces (2.6, 2.9).
