# Daily Plan (v62 -> v64)

Per-member plans of supplements/medicines, a per-dose log, and a calendar. Everything lives inside the
member object, so encryption, Pack ZIP, JSON export/import and merge cover it. No new files, libraries
or CSP changes (colors are CSS classes, no inline styles).

## Model
| Field on member | Meaning | Merge |
|---|---|---|
| `plans[]` | a course/routine ("Flu - Dr Lim"): name, note, startDate, endDate, trackFrom | `mergeSyncArray` (name/note/dates/trackFrom compared) |
| `planItems[]` | one medicine. `planId` null = "General". schedule `slots` / `interval{everyHours,firstDueAt}` / `asNeeded`. Dates blank = follow the plan | `mergeSyncArray`; `order`, `archivedRecordId` not compared |
| `intakeLog[]` | per-dose detail, kept 90 days. status `taken`/`skipped`/`missed` | `mergeIntakeLog`, never raises conflicts |
| `dayRollups[]` | one row per plan per day, written when detail ages out; `cleared:true` = user wiped the day | `mergeDayRollups`: higher version, live beats tombstone, else field max |
| `dayNotes[]` | one note (<=140 chars) per plan per day, kept until deleted | `mergeSyncArray` - free text conflicts are shown, never silently merged |
| `planSettings` | per-member slot names/times | higher version wins |
| `records[].planId` | receipt/report linked to a plan | travels with the record |
| `intakeSummaries[]` | v62 monthly totals; read-only legacy, no longer written | grow-only max |

## Doses
* Slot doses: id `${itemId}_${date}_${slot}` (deterministic: the same dose logged on two devices merges into ONE entry).
* Interval/as-needed doses: random id. Interval entries carry `dueAt`; auto-created fillers carry `fillFor`.
* **Every N hours is re-anchored on the dose actually taken.** next due = last taken + N. A skipped or missed
  dose keeps the rhythm (counts from when it was due). First dose = `firstDueAt` ("Start course now" sets it to now).
* Overdue doses WAIT for Take now / Skip (no auto-miss). Take now after a long gap records the doses that came
  and went as explicit `missed` entries (floor((now-due)/N)); undoing the dose removes its fillers too.
* Taking a dose >1h before it is due asks first. Doses belong to the local calendar day they happen (a 02:00 dose is "tomorrow").
* The app cannot ring an alarm (pure local PWA) - the editor says so.
* Ties in merge: live > tombstone, taken > skipped > missed, earlier takenAt.

## Calendar
Month grid, filter by plan. ✓ all taken · ◐ some missed/skipped · ✕ missed · 📝 note · 📎 document · dashed = planned.
`computeDay()` is the single source for the grid, the day sheet and the roll-up. "Missed" also covers a slot with no
entry on a past day and an interval day with no doses. Today shows no ✓ until it is over (it is still in progress).

## Retention
Per-dose detail ages out after `PLAN_KEEP_DAYS` (90). Each older day becomes at most one `dayRollups` row per plan
(also for days where nothing was logged, so "missed" is remembered). Rollups, notes and day marks are kept until the user
deletes them. `mergeMembers(..., {intakeCutoff})` drops incoming detail by the same `date < cutoff` rule, so a stale
device cannot resurrect folded days; rows the user cleared/deleted are never recreated.

## Deleting
* One day (sheet): clears marks + note (a `cleared` rollup stops it being recomputed); linked documents asked separately.
* One plan's whole history (Edit plan): clears log/rollups/notes and sets `trackFrom` so earlier days are not re-counted as missed.
* A whole plan: medicines + plan are tombstoned; separate prompts for the calendar history and for linked documents.

## Records
"Taken" never writes a Medication record. Stopping a medicine/plan offers ONCE to save it (grouped under the plan name,
`tags:['daily-plan']`, `archivedRecordId` prevents duplicates). The Medication List report appends a read-only
"Current daily plan" table. Receipts/reports are normal Records: "+ Add receipt / report" in a plan card, or "+ Add record"
in a calendar day, links the record to the plan only when added from inside a plan. Photos keep the existing
resize-on-attach (max 1280 px JPEG); PDFs are stored as is.

## Stop = immediate
Stopping a medicine or plan ends it YESTERDAY, so it leaves Today and shows as Ended at once. Doses already logged today
stay in the calendar.

## Not built
Notifications, refill counts, adherence statistics beyond the calendar and the 7-day count on slot medicines.
