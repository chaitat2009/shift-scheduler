# IICS Shift Scheduler — Rules Reference

This file is a human-readable export of every rule currently encoded in the
auto-fill engine. Use it for sanity-checking, sharing with colleagues, or
discussing with the team. Last sync: 2026-06-04.

To edit the rules in the app: open the scheduler and click 📋 **Rules**.

---

## Global rules

| # | Rule | Setting | Hard / Soft | Status |
|---|------|---------|-------------|--------|
| G1 | Each employee must hit a monthly minimum hours floor | `minHoursByMonth["YYYY-MM"]` (default 168) | Hard | ✅ enforced |
| G2 | Weekdays should have more workers than weekends | toggle (default ON) | Soft | ✅ rest day planter places pairs on weekend Sat+Sun first so weekdays keep headcount |
| G3 | Minimum counting workers per day | `2` | Hard | ✅ enforced |
| G4 | Max consecutive workdays per person | `5` (1 OFF must follow) | Hard | ✅ enforced via rest day planning |
| G5 | Rotate shift types per person (Jiraphan, Pawat, Thanaporn) | (preference) | Soft | ⚠️ not yet weighted in solver |
| G6 | Opener priority (start ≤ 08:00) | Thanaporn → Jiraphan | Hard + Soft | ✅ opener coverage hard; priority order soft |
| G7 | Closer slot fairness over time | Thanaporn ≈ 70% of closer slots per any 7-day window; Pawat & Jiraphan share the rest | Soft | ✅ via sliding-window penalty on the deviation from 70% |
| G8 | Prefer 2 consecutive OFF days | toggle (default ON) | Soft | ✅ rest day planter places pairs first, only falls back to singles when pairs don't fit |
| G9 | Honor manually-set cells, never overwrite | always | Hard | ✅ enforced (cells with any explicit value are skipped) |
| G10 | Every working shift ≥ 8 hours | `minHoursPerShift = 8` | Soft warning | ⚠️ no manual rejection — flagged in validator only |
| OTCAP | ~~Combined team OT cap~~ | **Removed** — OT happens because closers are required every day; capping it would conflict with G7 coverage. The field still exists in the UI but is ignored by the solver. | — | ❌ no longer enforced |
| OT | OT definition | Monthly counted hours above the month's minimum hours | — | ✅ |
| G11 | Target OFF-day count per person | = count of (weekends + holidays) for the month. Penalty if a person has more or less OFF/R cells than this target. | Soft (weight 30) | ✅ |

### Other globals

| Field | Default | Meaning |
|-------|---------|---------|
| `openerStartByMin` | `480` (= 08:00) | A shift is an "opener" if it starts at or before this minute |
| `closerEndByMin` | `1200` (= 20:00) | A shift is a "closer" if it ends at or after this minute |
| `holidays` | `[]` | List of `YYYY-MM-DD` dates treated like weekends |
| `weekdayShouldExceedWeekend` | `true` | Toggle for G2 (soft) |
| `preferTwoConsecutiveOff` | `true` | Toggle for G8 (soft) |
| `rotateShiftTypesPerPerson` | `true` | Toggle for G5 (soft) |

---

## Per-employee rules

Legend:
- **Allowed shifts** — the only shifts the solver may assign to this person
- **Break (h)** — hours subtracted from each shift for accounting (Panadda is part-time with a 1h break)
- **OT elig.** — whether this person can accrue OT hours toward the team cap
- **Weekends** — works Sat/Sun
- **Headcount** — counts toward the daily ≥ 2 minimum
- **Opener** — can satisfy the daily ≥ 1 opener requirement
- **Closer** — can satisfy the daily ≥ 1 closer requirement

| ID | Name | Allowed shifts | Break | OT elig. | Wknd | Head | Open | Close |
|----|------|----------------|-------|----------|------|------|------|-------|
| 670199 | **Aksorn** | 08:00-16:00 | 0 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 430084 | **Piyamas** | 08:00-16:00 | 0 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 680049 | **Thanaree** | 08:00-16:00 | 0 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 116612 | **Panadda** | 08:00-17:00 | **1** (part-time) | **❌** | ✅ | ✅ | ✅ | ❌ |
| 670089 | **Jiraphan** | 08:00-16:00, 09:00-17:00, 08:00-20:00, 09:00-20:00 | 0 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 660049 | **Pawat** | 10:00-18:00, 10:00-20:00 | 0 | ✅ | ✅ | ✅ | ❌ | ✅ |
| 660127 | **Thanaporn** | 08:00-16:00, 08:00-20:00 | 0 | ✅ | ✅ | ✅ | ✅ | ✅ |

### Notes per person

- **Aksorn / Piyamas / Thanaree** — "regular staff, weekday-only, fixed 8-16 shift". They don't count toward the daily headcount minimum and aren't allowed to be the opener-of-record (even though their shift starts at 08:00). The solver gives them zero planned rest days — weekends already break the 5-consecutive cap.
- **Panadda** — "part-time, fixed 8-17 shift, every day including weekends". Her 9h shift counts as 8h (1h unpaid break). She **cannot accrue OT** under any rule. She counts toward headcount AND counts as an opener (her shift starts at 08:00).
- **Jiraphan** — most flexible flex employee. Can open (8-16) or close (8-20 / 9-20). Has 4 allowed shifts.
- **Pawat** — closer-only. Starts at 10. Can satisfy the closer requirement on 10-20 but never the opener requirement.
- **Thanaporn** — primary opener AND primary closer. Two allowed shifts: 8-16 (cheap, no OT) and 8-20 (closer, 4h OT).

---

## Priority lists

### Opener priority (G6)
1. **Thanaporn** (660127)
2. **Jiraphan** (670089)
3. **Panadda** (116612) — fixed shift, always covers opener when working

When the opener slot needs filling, Thanaporn is picked first if she's working and not already on a non-opener shift. If she's resting, Jiraphan takes it.

### Closer priority (G7) — by OT-share quota
1. **Thanaporn** (660127) — quota = 70% of team OT cap
2. **Pawat** (660049) — quota = 15% of team OT cap
3. **Jiraphan** (670089) — quota = 15% of team OT cap

### OT target shares
| Person | Share | OT hours when cap = 40 | OT hours when cap = 150 |
|--------|-------|------------------------|--------------------------|
| Thanaporn | 70 % | 28 h | 105 h |
| Pawat     | 15 % |  6 h |  22 h |
| Jiraphan  | 15 % |  6 h |  22 h |
| **Total** | **100 %** | **40 h** | **150 h** |

The solver uses a **sliding 7-day window** fairness rule on closer slots:
in any 7-day window, Thanaporn should hold ≈ 70% of the closer slots
(matching her historical share). Deviations from that ratio are penalized,
producing an even distribution across the month rather than a greedy
"Thanaporn first, others later" pattern. Pawat and Jiraphan have no
preference between each other — they fill the remaining ~30% based on
which one is working that day.

---

## Solver pipeline (how Auto-fill thinks)

1. **Phase A · Carry-over** — for each employee, walk backward through previous months to compute consecutive workdays entering day 1.
2. **Phase B · Force weekend OFFs** — non-weekend workers (Aksorn, Piyamas, Thanaree) have all weekends set to OFF immediately.
3. **Phase B+C · Rest day allocation** — for each employee, compute target work days = `ceil(minH / shortest allowed shift hours)`. Plant `days − target` rest days evenly across the month, anchored by the 5-day consecutive cap. For openers (Thanaporn, then Jiraphan), apply **hard exclusion**: Jiraphan never rests on a day Thanaporn already rests. A safety net at the end inserts an extra rest if any consecutive run still exceeds 5.
4. **Phase D · Shift type assignment** — per day:
   1. Fixed-shift employees fill in their one allowed shift.
   2. **Closer selection** — pick the closer-capable employee most behind their OT quota; skip anyone who would push past the team OT cap.
   3. **Opener selection** — fill opener slot from priority list.
   4. **Everyone else** — shortest allowed shift (cheapest = no OT).
5. **Phase E · Validate + repair** — run all hard rules. If `noCloser` / `noOpener` violations exist, try upgrading shifts of working employees to cover (but never past the OT cap). Up to 5 repair passes.
6. **Apply** — if zero violations, apply silently. Otherwise show the violation list and ask before applying.

---

## Things still to decide / add

- ⚠️ G5 (shift type rotation) — flex employees can get the same shift many days in a row.
- Holiday list is empty by default. Add via Rules modal.
- The repair loop is shallow (5 passes, only upgrades existing working shifts). Doesn't yet try to swap rest days between employees.
