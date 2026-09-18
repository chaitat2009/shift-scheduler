# IICS Shift Scheduler

Node + Express + SQLite + Python OR-tools CP-SAT optimizer.

## First-time setup

1. **Install Node.js 22 or newer** (for native SQLite support).
2. **Install Python 3.9+** from https://python.org (tick "Add Python to PATH").
3. **Install OR-tools**: `pip install ortools` (about 50 MB).
4. **Install Node dependencies**: in this folder, run `npm install`.

## Running

Double-click **`start.bat`** (Windows). It will:
- Verify `ortools` is installed and `pip install ortools` if not.
- Launch the Node server on port **3012**.

Then open:
- On your PC: http://localhost:3012
- Teammates on your LAN: `http://<your-pc-ip>:3012`

## Architecture

```
Browser (public/index.html)
       │ REST /api/...
       ▼
Node + Express (server.js) ──── SQLite (scheduler.db)
       │
       │ spawn python on Auto-fill
       ▼
Python CP-SAT (python/optimizer.py)
```

## Folders

- `public/` — front-end (HTML/CSS/JS)
- `python/` — optimizer
- `scheduler.db` — SQLite database (created on first run)
- `RULES.md` — human-readable rules reference (in sync with the Rules modal)

## Key API endpoints

- `GET /api/state` — full app state (employees, shifts, rules, etc.)
- `PUT /api/shifts` — upsert / delete shift cells
- `PUT /api/employees` — replace employee list (reorder, bulk import)
- `DELETE /api/employees/:code` — remove an employee + cascade their shifts
- `PUT /api/rules` — save scheduling rules
- `PUT /api/min-hours` — save monthly min-hours map
- `POST /api/state/import` — bulk import from Excel parse
- `POST /api/schedule/optimize` — run CP-SAT on the current month

## Backups

The whole database is the single file **`scheduler.db`** in the project root.
Copy it anywhere to back it up. Restore by overwriting.

## Google Calendar sync (optional, per employee)

Pushes each connected employee's shifts into a **"ตารางเวร IICS"** calendar in
their own Google account, automatically, every time the schedule changes.
Outbound HTTPS only — no port forwarding or tunnel needed.

### One-time setup (admin)

1. In [Google Cloud Console](https://console.cloud.google.com) create a project
   and enable the **Google Calendar API**.
2. **OAuth consent screen**: choose *Internal* if the hospital uses Google
   Workspace; otherwise *External* and then **Publish app** (do not leave it in
   "Testing" — tokens expire after 7 days there).
3. **Credentials → OAuth client ID → Web application**, redirect URI
   `http://localhost:3012/api/google/callback`. Download the JSON.
4. Drop the downloaded `client_secret_….json` in this folder (next to
   `server.js`) and restart. The log prints `[google] Calendar sync enabled`.

### Per employee

Click the **G** button next to a name and follow the two steps in the modal:
**1. เปิด Google** (log in, click Allow) → Google redirects the browser to
`http://localhost:3012/...`. On the scheduler PC that completes automatically.
On any other PC the page fails to load (Google only allows a localhost
redirect) — copy the URL from the address bar, paste it into the modal and
click **2. ยืนยัน**. One-time only; syncing is automatic afterwards.

- Timed shifts → timed events; R / V / E → all-day events; OFF → no event.
- Clearing or changing a cell updates/deletes the event (IDs are deterministic).
- "ซิงค์ใหม่ทั้งหมด" re-pushes everything and removes stray events.
- Disconnecting revokes the token; optionally deletes the calendar in Google.
- Failed pushes (PC offline etc.) are retried every 10 minutes.

Env overrides: `GOOGLE_CLIENT_SECRET_FILE` (path), `GOOGLE_SCOPE` (defaults to
`calendar.app.created`, the least-privilege scope).
