# Daily Plan (v62)

Per-member checklist of supplements/medicines to take, with a separate intake log.
Everything lives inside the member object, so encryption, Pack ZIP, JSON export/import and
merge cover it with no extra plumbing. No new files, libraries or CSP changes.

## Data
| Field on member | Shape | Merge |
|---|---|---|
| `planItems[]` | `{id, kind, name, dose, meal, schedule:{mode:'slots'\|'asNeeded', slots[]}, time, icon, color, note, order, startDate, endDate, archivedRecordId}` + sync meta | `mergeSyncArray`; `order` and `archivedRecordId` are NOT compared (cosmetic) |
| `intakeLog[]` | `{id, itemId, date, slot\|null, status:'taken'\|'skipped', takenAt}` + sync meta | `mergeIntakeLog` - never raises conflicts |
| `intakeSummaries[]` | `{id:`${itemId}_${YYYY-MM}`, itemId, month, taken, skipped, expected}` | per-field max (grow-only) |
| `planSettings` | `{version, slotTimes{}, slotLabels{}}` | higher version wins, tie keeps local |

## Log entry ids
* Slot doses: `${itemId}_${date}_${slot}` - deterministic, so the same dose logged on two devices becomes ONE entry.
  (`_` not `|`: `sanitizeId()` only allows `[A-Za-z0-9_-]`.)
* As-needed doses: `freshId('in')`, immutable. `takenAt` is a normal editable field.
* Undo = tombstone; re-taking the same slot revives the same entry (version keeps climbing).
* Tie rules on equal versions (symmetric): live > tombstone, taken > skipped, earlier takenAt.

## Retention
Detail is kept `PLAN_KEEP_DAYS` (90). Only WHOLE months strictly before the cutoff are folded into
`intakeSummaries`; `mergeMembers(..., {intakeCutoff})` drops incoming detail by the same predicate
(`isCompactedDate`), so a stale device cannot resurrect folded rows. Summaries are never double-counted.

## Medication records
* "Taken" never writes a Medication record.
* Stopping an item offers ONCE to save it as a Medication record (`tags:['daily-plan']`,
  `archivedRecordId` prevents duplicates); ended items keep a "Save to records" button.
* The Medication List report appends a read-only "Current daily plan" table derived live from the plan.

## Time
All plan dates are LOCAL calendar dates (`localDateStr`), unlike older code that uses UTC dates.

## Not in v62 (planned v63)
Interval dosing (`clock` / `sinceLast`), as-needed minimum-gap warning.
