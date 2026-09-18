#!/usr/bin/env python3
"""IICS Shift Scheduler — CP-SAT optimizer.

Reads a JSON request from stdin, solves the scheduling problem using Google
OR-tools' CP-SAT solver, and writes the optimized schedule to stdout.

Run: pip install ortools

Request JSON shape:
  {
    "year": 2026,
    "month": 5,                       # 0-indexed (June)
    "employees": [{"id": "660049", "name": "Pawat"}, ...],
    "userSet": {"660049": {"2026-06-15": "OFF"}, ...},  # immutable cells
    "rules": { "global": {...}, "perEmployee": {...}, "priorities": {...} },
    "minHours": 176,                  # for this month
    "carryOver": {"660049": 3}        # consecutive workdays entering day 1
  }

Response JSON shape:
  {
    "status": "ok" | "infeasible" | "error",
    "schedule": {"660049": {"2026-06-01": "08:00-17:00", ...}, ...},
    "stats": {"totalH": {...}, "otH": {...}, "teamOt": 42},
    "elapsedMs": 543,
    "objective": 1234,
    "message": "..."
  }
"""

import sys
import json
import time
import traceback
from calendar import monthrange
from datetime import date

try:
    from ortools.sat.python import cp_model
except ImportError:
    print(json.dumps({
        "status": "error",
        "message": "OR-tools not installed. Run: pip install ortools"
    }))
    sys.exit(1)


# ── Shift parsing helpers ─────────────────────────────────────────────
def shift_hours(shift):
    """Raw shift duration in hours (no break subtracted)."""
    if shift in ("OFF", "R"):
        return 0
    if shift in ("V", "E"):
        return 8
    a, b = shift.split("-")
    h1, m1 = a.split(":")
    h2, m2 = b.split(":")
    return (int(h2) * 60 + int(m2) - int(h1) * 60 - int(m1)) // 60


def counted_hours(shift, break_hours):
    """Counted hours = raw shift hours − the employee's break hours."""
    if shift in ("OFF", "R"):
        return 0
    if shift in ("V", "E"):
        return 8
    return max(0, shift_hours(shift) - break_hours)


def shift_start_min(shift):
    if "-" not in shift or shift in ("OFF", "R", "V", "E"):
        return None
    h, m = shift.split("-")[0].split(":")
    return int(h) * 60 + int(m)


def shift_end_min(shift):
    if "-" not in shift or shift in ("OFF", "R", "V", "E"):
        return None
    h, m = shift.split("-")[1].split(":")
    return int(h) * 60 + int(m)


# ── Main solver ────────────────────────────────────────────────────────
def build_and_solve(req):
    year = req["year"]
    month = req["month"]
    employees = req["employees"]
    user_set = req.get("userSet", {})
    rules = req["rules"]
    min_h = int(req["minHours"])
    carry = req.get("carryOver", {})

    days_in_month = monthrange(year, month + 1)[1]
    days = list(range(days_in_month))

    def date_key(d):
        return f"{year:04d}-{month + 1:02d}-{d + 1:02d}"

    def is_weekend(d):
        return date(year, month + 1, d + 1).weekday() >= 5

    g = rules["global"]
    per_emp = rules["perEmployee"]
    priorities = rules.get("priorities", {})

    # Holidays / unit meetings can be either old-style ["YYYY-MM-DD"] or
    # new-style [{"date": "YYYY-MM-DD", "name": "…"}]. Accept both shapes.
    def _dates_of(field):
        out = set()
        for entry in g.get(field, []) or []:
            if isinstance(entry, str):
                out.add(entry)
            elif isinstance(entry, dict) and entry.get("date"):
                out.add(entry["date"])
        return out

    holidays = _dates_of("holidays")
    unit_meetings = _dates_of("unitMeetings")
    is_off_day = [is_weekend(d) or date_key(d) in holidays for d in days]
    # Day indices that are unit-meeting days (everyone must work)
    meeting_day_indices = [d for d in days if date_key(d) in unit_meetings]

    cap = int(g["maxConsecutiveWorkdays"])
    min_workers = int(g["minCountingWorkersPerDay"])
    opener_start = int(g["openerStartByMin"])
    closer_end = int(g["closerEndByMin"])
    team_ot_cap = int(g["otCapHoursPerMonth"])
    prefer_pairs = bool(g.get("preferTwoConsecutiveOff", True))
    weekday_pref = bool(g.get("weekdayShouldExceedWeekend", True))

    emp_ids = [e["id"] for e in employees]

    # Per-employee universe of values the SOLVER may assign.
    #
    # IMPORTANT: R, V, E are user-only codes — they represent decisions the
    # user has already made (Request, Vacation, Event). The solver must never
    # produce them on its own; they're added to the universe only on cells
    # where the user explicitly set them (handled below).
    universe = {}
    for eid in emp_ids:
        r = per_emp.get(eid)
        if r:
            universe[eid] = list(r["allowedShifts"]) + ["OFF"]
        else:
            universe[eid] = ["OFF"]
    # Add user-set codes (R, V, E, or any non-allowed shift) to the per-cell
    # universe only for the specific cells where the user used them.
    extra_cell_values = {}  # (eid, day_idx) -> [extra codes]
    for eid, by_date in user_set.items():
        if eid not in universe:
            continue
        for dk, val in by_date.items():
            for d in days:
                if date_key(d) == dk:
                    if val not in universe[eid]:
                        extra_cell_values.setdefault((eid, d), []).append(val)
                    break

    # Per-employee OT quota (share of team cap)
    ot_share = priorities.get("otTargetShare", {})
    person_quota = {}
    for eid in emp_ids:
        share = ot_share.get(eid, 0) / 100.0
        person_quota[eid] = int(round(team_ot_cap * share))

    # ── Build CP-SAT model ──
    model = cp_model.CpModel()

    # Per-cell effective code list = base universe + any extras the user set on
    # that specific cell (e.g. "V" on day 12 for Pawat).
    def cell_codes(eid, d):
        base = universe[eid]
        extras = extra_cell_values.get((eid, d), [])
        return base + extras

    # x[(eid, d, code)] = 1 if emp eid is assigned `code` on day d
    x = {}
    for eid in emp_ids:
        for d in days:
            for code in cell_codes(eid, d):
                x[(eid, d, code)] = model.new_bool_var(f"x_{eid}_{d}_{code}")

    # Exactly one code per cell
    for eid in emp_ids:
        for d in days:
            model.add_exactly_one(x[(eid, d, code)] for code in cell_codes(eid, d))

    # Lock user-set cells to the value the user chose.
    for eid, by_date in user_set.items():
        if eid not in universe:
            continue
        for dk, val in by_date.items():
            d_idx = None
            for d in days:
                if date_key(d) == dk:
                    d_idx = d
                    break
            if d_idx is None:
                continue
            if (eid, d_idx, val) in x:
                model.add(x[(eid, d_idx, val)] == 1)

    # Non-weekend workers: weekends/holidays must be OFF
    # EXCEPTION: unit-meeting days override this rule (everyone must work).
    for eid in emp_ids:
        r = per_emp.get(eid)
        if not r or r.get("worksWeekends", True):
            continue
        for d in days:
            if is_off_day[d] and d not in meeting_day_indices:
                model.add(x[(eid, d, "OFF")] == 1)

    # Unit-meeting days: every employee must be on a working shift
    # (not OFF / R / V). Use the `working` derived bool defined later.
    # We can't reference `working` here yet — add a placeholder list and
    # apply the constraint after `working` is built (see below).
    meeting_constraint_targets = list(meeting_day_indices)

    # Derived bool: working[eid][d] = 1 if any time-range shift or V/E on that day
    working = {}
    for eid in emp_ids:
        for d in days:
            non_off_vars = []
            for code in cell_codes(eid, d):
                if code in ("OFF", "R"):
                    continue
                non_off_vars.append(x[(eid, d, code)])
            w = model.new_bool_var(f"work_{eid}_{d}")
            if non_off_vars:
                # w == sum(non_off_vars). Since exactly_one across all codes,
                # this is equivalent to "not OFF and not R".
                model.add(sum(non_off_vars) == w)
            else:
                model.add(w == 0)
            working[(eid, d)] = w

    # Unit-meeting days: every employee must be working (hard constraint).
    # Applied here so all `working` BoolVars exist.
    for d in meeting_constraint_targets:
        for eid in emp_ids:
            model.add(working[(eid, d)] == 1)

    # ── Hard constraints ──

    # G3: at least N counting workers per day
    for d in days:
        terms = []
        for eid in emp_ids:
            r = per_emp.get(eid)
            if r and r.get("countsForHeadcount"):
                terms.append(working[(eid, d)])
        if terms:
            model.add(sum(terms) >= min_workers)

    # G6: ≥1 opener per day (shift starts by opener_start AND counts as opener)
    for d in days:
        opener_vars = []
        for eid in emp_ids:
            r = per_emp.get(eid)
            if not r or not r.get("countsAsOpener"):
                continue
            for code in r["allowedShifts"]:
                s = shift_start_min(code)
                if s is not None and s <= opener_start:
                    opener_vars.append(x[(eid, d, code)])
        if opener_vars:
            model.add(sum(opener_vars) >= 1)

    # G7: ≥1 closer per day (shift ends ≥ closer_end AND counts as closer)
    for d in days:
        closer_vars = []
        for eid in emp_ids:
            r = per_emp.get(eid)
            if not r or not r.get("countsAsCloser"):
                continue
            for code in r["allowedShifts"]:
                e = shift_end_min(code)
                if e is not None and e >= closer_end:
                    closer_vars.append(x[(eid, d, code)])
        if closer_vars:
            model.add(sum(closer_vars) >= 1)

    # G4: max `cap` consecutive workdays (per employee). Sliding window of size
    # cap+1 must have at most `cap` working days. Window can extend back into
    # the previous month via the carry-over count.
    W = cap + 1
    for eid in emp_ids:
        c = int(carry.get(eid, 0))
        # All possible window starts (including those reaching into the carry zone)
        for s in range(-c, days_in_month - W + 1):
            carry_in_window = 0
            var_list = []
            for offset in range(W):
                i = s + offset
                if i < 0:
                    if i >= -c:
                        carry_in_window += 1
                else:
                    var_list.append(working[(eid, i)])
            # Skip if carry alone exceeds cap (prior-month data already broken)
            if carry_in_window > cap:
                continue
            if var_list:
                model.add(sum(var_list) <= cap - carry_in_window)

    # G1: each employee must hit min hours (sum of counted hours ≥ min_h)
    hours_expr = {}
    for eid in emp_ids:
        r = per_emp.get(eid)
        if not r:
            continue
        bh = int(r.get("breakHours", 0) or 0)
        terms = []
        for d in days:
            for code in cell_codes(eid, d):
                ch = counted_hours(code, bh)
                if ch > 0:
                    terms.append(ch * x[(eid, d, code)])
        # Sum may be a constant if empty
        if terms:
            total = sum(terms)
        else:
            total = 0
        hours_expr[eid] = total
        model.add(total >= min_h)

    # Hard cap for OT-INELIGIBLE employees only (e.g. Panadda). They can't
    # accrue OT, so we keep them near minHours. Eligible employees have no
    # hard cap — distribution is governed by the soft objective.
    for eid in emp_ids:
        r = per_emp.get(eid)
        if not r:
            continue
        if not r.get("eligibleForOT", True):
            model.add(hours_expr[eid] <= min_h + 8)

    # Eligible-OT terms (used by the soft fairness objective below)
    eligible_terms = []
    for eid in emp_ids:
        r = per_emp.get(eid)
        if not r or not r.get("eligibleForOT", True):
            continue
        if eid not in hours_expr:
            continue
        eligible_terms.append(hours_expr[eid] - min_h)

    # ── Soft preferences (objective) ──
    soft_terms = []

    # G8: penalize isolated rest days (rest day with work neighbors on both sides)
    if prefer_pairs:
        for eid in emp_ids:
            for d in range(1, days_in_month - 1):
                # isolated = working[d-1] AND NOT working[d] AND working[d+1]
                iso = model.new_bool_var(f"iso_{eid}_{d}")
                w_prev = working[(eid, d - 1)]
                w_curr = working[(eid, d)]
                w_next = working[(eid, d + 1)]
                # iso == 1 iff w_prev=1, w_curr=0, w_next=1
                # Encode via reified constraint:
                # iso == 1 → w_prev=1, w_curr=0, w_next=1
                model.add(w_prev == 1).only_enforce_if(iso)
                model.add(w_curr == 0).only_enforce_if(iso)
                model.add(w_next == 1).only_enforce_if(iso)
                # iso == 0 → at least one of (w_prev=0, w_curr=1, w_next=0)
                model.add_bool_or([
                    w_prev.Not(), w_curr, w_next.Not()
                ]).only_enforce_if(iso.Not())
                soft_terms.append(50 * iso)

    # G2: prefer weekends to have fewer workers than weekdays. For each
    # weekend-flex employee, penalize working on weekend days.
    if weekday_pref:
        for eid in emp_ids:
            r = per_emp.get(eid)
            if not r or not r.get("worksWeekends"):
                continue
            for d in days:
                if is_off_day[d]:
                    soft_terms.append(5 * working[(eid, d)])

    # NEW: penalize 3+ consecutive OFF days (no person should be off ≥3 days
    # in a row, since that's an unnatural cluster — 2-day pairs are the norm).
    for eid in emp_ids:
        for s in range(days_in_month - 2):
            three_off = model.new_bool_var(f"3off_{eid}_{s}")
            sum_work_3 = working[(eid, s)] + working[(eid, s + 1)] + working[(eid, s + 2)]
            # three_off = 1 iff all 3 days are non-working
            model.add(sum_work_3 == 0).only_enforce_if(three_off)
            model.add(sum_work_3 >= 1).only_enforce_if(three_off.Not())
            soft_terms.append(30 * three_off)

    # NEW: sliding-window OT fairness measured in OT HOURS (not closer days).
    # Thanaporn 8-20 = 4h OT, Pawat 10-20 = 2h, Jiraphan 9-20 = 3h or 8-20 = 4h.
    # Counting days would over-allocate to Thanaporn since each of her closer
    # days produces 4h OT vs Pawat's 2h.
    #
    # In any 7-day window, Thanaporn's OT hours should be ~70% of the team's
    # OT hours in that window. Penalty for deviation.

    # Per-day OT-hour expression for each OT-eligible employee.
    # ot_per_day[(eid, d)] = sum over allowed codes of (per-shift OT × x).
    ot_per_day_expr = {}
    for eid in emp_ids:
        r = per_emp.get(eid)
        if not r or not r.get("eligibleForOT", True):
            continue
        bh = int(r.get("breakHours", 0) or 0)
        for d in days:
            terms = []
            for code in cell_codes(eid, d):
                ch = counted_hours(code, bh)
                ot_per_shift = max(0, ch - 8)
                if ot_per_shift > 0:
                    terms.append(ot_per_shift * x[(eid, d, code)])
            if terms:
                ot_per_day_expr[(eid, d)] = sum(terms)

    W_FAIR = 7
    closer_priority = priorities.get("closer", [])
    if closer_priority:
        top_closer = closer_priority[0]
        top_share_pct = int(ot_share.get(top_closer, 70))
        # Scale by 10 to keep integer arithmetic clean (70 → 7)
        share_factor = max(1, top_share_pct // 10)
        # Maximum OT in a window is ≤ days × max shift OT (e.g. 7 × 4 = 28)
        max_window_ot = W_FAIR * 4

        for w_start in range(days_in_month - W_FAIR + 1):
            top_in_w = []
            total_in_w = []
            for d in range(w_start, w_start + W_FAIR):
                if (top_closer, d) in ot_per_day_expr:
                    top_in_w.append(ot_per_day_expr[(top_closer, d)])
                for eid in emp_ids:
                    if (eid, d) in ot_per_day_expr:
                        total_in_w.append(ot_per_day_expr[(eid, d)])
            if total_in_w:
                # Want: top_ot_hours ≈ (top_share_pct / 100) × total_ot_hours
                # Scaled (×10): 10 × top_ot ≈ share_factor × total_ot
                top_sum = sum(top_in_w) if top_in_w else 0
                total_sum = sum(total_in_w)
                scaled_diff = model.new_int_var(
                    -10 * max_window_ot * len(emp_ids),
                    10 * max_window_ot * len(emp_ids),
                    f"sd_{w_start}"
                )
                model.add(scaled_diff == 10 * top_sum - share_factor * total_sum)
                abs_diff = model.new_int_var(0, 10 * max_window_ot * len(emp_ids), f"ad_{w_start}")
                model.add_abs_equality(abs_diff, scaled_diff)
                soft_terms.append(2 * abs_diff)

    # NEW: weekday headcount preference. Each weekday should have ≥ 3 counting
    # workers (Thanaporn/Jiraphan/Pawat/Panadda — 4 in the pool). Penalty per
    # weekday under the target prevents two counting employees from happening
    # to rest the same day.
    weekday_target = 3
    for d in days:
        if is_off_day[d]:
            continue
        counting_vars = []
        for eid in emp_ids:
            r = per_emp.get(eid)
            if r and r.get("countsForHeadcount"):
                counting_vars.append(working[(eid, d)])
        if counting_vars:
            shortfall = model.new_int_var(0, weekday_target, f"short_{d}")
            model.add(shortfall >= weekday_target - sum(counting_vars))
            soft_terms.append(40 * shortfall)

    # NEW: target OFF-day count per employee.
    # Baseline rest days = number of weekend + holiday days in the month.
    # Each employee's actual OFF + R count should match this target. Penalty
    # per day of deviation pushes everyone toward the same total work pattern,
    # regardless of how long their individual shifts are. (Without this, a
    # flex employee on long 12h shifts could hit minHours with fewer working
    # days, accidentally giving them more rest than weekday-only colleagues.)
    target_off_days = sum(1 for off in is_off_day if off)
    for eid in emp_ids:
        off_terms = []
        for d in days:
            for code in cell_codes(eid, d):
                if code in ("OFF", "R"):
                    off_terms.append(x[(eid, d, code)])
        if not off_terms:
            continue
        off_count_var = model.new_int_var(0, days_in_month, f"off_{eid}")
        model.add(off_count_var == sum(off_terms))
        diff_off = model.new_int_var(
            -days_in_month, days_in_month, f"off_diff_{eid}"
        )
        model.add(diff_off == off_count_var - target_off_days)
        abs_off = model.new_int_var(0, days_in_month, f"off_abs_{eid}")
        model.add_abs_equality(abs_off, diff_off)
        soft_terms.append(30 * abs_off)

    # NEW: weekend-rest rotation. Distribute weekend rest days equally across
    # all flex employees who work weekends. Without this, the solver tends to
    # park the same 1-2 people on weekend rest every week.
    #
    # Total weekend rest slots = num_weekend_days × (num_flex − min_workers).
    # Target per employee = total / num_flex (rounded).
    flex_ids = [
        eid for eid in emp_ids
        if (per_emp.get(eid) or {}).get("worksWeekends")
        and (per_emp.get(eid) or {}).get("countsForHeadcount")
    ]
    weekend_day_indices = [d for d in days if is_off_day[d]]
    if flex_ids and weekend_day_indices:
        total_weekend_rest_slots = len(weekend_day_indices) * (len(flex_ids) - min_workers)
        target_per_emp = max(0, total_weekend_rest_slots // len(flex_ids))
        for eid in flex_ids:
            # Count rest days on weekends (1 - working). Use NotWorking = OFF/R.
            we_rest_terms = [(1 - working[(eid, d)]) for d in weekend_day_indices]
            we_rest_count = model.new_int_var(0, len(weekend_day_indices), f"we_rest_{eid}")
            model.add(we_rest_count == sum(we_rest_terms))
            diff = model.new_int_var(
                -len(weekend_day_indices), len(weekend_day_indices), f"we_diff_{eid}"
            )
            model.add(diff == we_rest_count - target_per_emp)
            abs_diff = model.new_int_var(0, len(weekend_day_indices), f"we_abs_{eid}")
            model.add_abs_equality(abs_diff, diff)
            soft_terms.append(25 * abs_diff)

    if soft_terms:
        model.minimize(sum(soft_terms))

    # ── Solve ──
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 15.0
    solver.parameters.num_search_workers = 4

    t0 = time.time()
    status = solver.solve(model)
    elapsed_ms = int((time.time() - t0) * 1000)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {
            "status": "infeasible",
            "message": f"CP-SAT status: {solver.status_name(status)}. "
                       f"Likely cause: rules conflict (e.g. OT cap too low for "
                       f"required coverage, or carry-over too high).",
            "elapsedMs": elapsed_ms,
        }

    # ── Extract result ──
    schedule = {}
    stats_total = {}
    stats_ot = {}
    for eid in emp_ids:
        schedule[eid] = {}
        for d in days:
            for code in cell_codes(eid, d):
                if solver.value(x[(eid, d, code)]) == 1:
                    schedule[eid][date_key(d)] = code
                    break
        if eid in hours_expr:
            h_val = solver.value(hours_expr[eid]) if not isinstance(hours_expr[eid], int) else hours_expr[eid]
            stats_total[eid] = int(h_val)
            r = per_emp.get(eid, {})
            if r.get("eligibleForOT", True):
                stats_ot[eid] = max(0, int(h_val) - min_h)
            else:
                stats_ot[eid] = 0

    team_ot = sum(stats_ot.values())
    return {
        "status": "ok",
        "schedule": schedule,
        "stats": {"totalH": stats_total, "otH": stats_ot, "teamOt": team_ot},
        "elapsedMs": elapsed_ms,
        "objective": int(solver.objective_value) if soft_terms else 0,
    }


def main():
    try:
        req = json.loads(sys.stdin.read())
        result = build_and_solve(req)
        print(json.dumps(result))
    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
