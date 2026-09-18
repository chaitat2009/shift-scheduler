// IICS Shift Scheduler — server
// Node + Express + SQLite (built into Node 22+). Static files in public/.
// Optimizer (Phase 2) is a Python subprocess called from /api/schedule/optimize.

const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { createGoogleSync } = require('./lib/google-sync');

const app = express();
const PORT = Number(process.env.PORT) || 3012;
const HOST = '0.0.0.0';   // bind to all interfaces so teammates can reach us
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'scheduler.db'));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Resolve Python at startup ──────────────────────────────────────────
// Strategy:
//   1. Honor PYTHON env override unconditionally
//   2. Collect every interpreter `where`/`which` knows about
//   3. Strongly PREFER a non-Microsoft-Store install (direct spawn works)
//   4. Fall back to MS Store Python (only works when parent has a real
//      console — i.e. start.bat, not the system launcher)
const fs = require('fs');

function isMsStorePath(p) {
  return typeof p === 'string' && /\\WindowsApps\\/i.test(p);
}

function findPython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const isWin = process.platform === 'win32';
  const candidates = isWin ? ['python', 'py', 'python3'] : ['python3', 'python'];
  const whichCmd = isWin ? 'where' : 'which';

  // Collect all installations across all candidate command names
  const allPaths = [];
  for (const cmd of candidates) {
    try {
      const out = execSync(`${whichCmd} ${cmd}`, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(p => allPaths.push(p));
    } catch {
      // not found
    }
  }

  if (!allPaths.length) return null;

  if (isWin) {
    // Prefer a real .exe install that is NOT MS Store sandboxed
    const real = allPaths.find(p => /\.exe$/i.test(p) && !isMsStorePath(p) && fs.existsSync(p));
    if (real) return real;
    // Only MS Store available — return bare command, but flag it
    console.warn('[optimize] Only Microsoft Store Python detected. ' +
      'It will work from start.bat but Access-Denied via the system launcher. ' +
      'Install Python from https://python.org to use the launcher.');
    return 'python';
  }
  return allPaths[0];
}

const PYTHON_CMD = findPython();
const PYTHON_IS_MS_STORE = PYTHON_CMD && isMsStorePath(PYTHON_CMD);
if (PYTHON_CMD) {
  console.log(`[optimize] Python command: ${PYTHON_CMD}${PYTHON_IS_MS_STORE ? '  (Microsoft Store)' : ''}`);
} else {
  console.warn(`[optimize] No Python found on PATH. Auto-fill will return 500 until Python is installed.`);
}

// Spawn helper. Prefers direct execution of a known python.exe path. Only
// uses shell:true when the command isn't an absolute path (i.e. needs PATH
// resolution) — that's the MS Store fallback case.
function spawnOptimizer(scriptPath) {
  const opts = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (process.platform === 'win32' && (!path.isAbsolute(PYTHON_CMD) || isMsStorePath(PYTHON_CMD))) {
    const q = s => s.includes(' ') ? `"${s}"` : s;
    return spawn(`${q(PYTHON_CMD)} ${q(scriptPath)}`, { ...opts, shell: true });
  }
  return spawn(PYTHON_CMD, [scriptPath], opts);
}

// ── Schema ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    emp_code      TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    position      TEXT,
    display_order INTEGER DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS shifts (
    emp_code   TEXT NOT NULL,
    date_key   TEXT NOT NULL,           -- YYYY-MM-DD
    value      TEXT NOT NULL,           -- "OFF", "R", "V", "E", or "HH:MM-HH:MM"
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (emp_code, date_key)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL                  -- JSON blob
  );
`);

// Google Calendar push-sync (opt-in per employee). Disabled until a
// client_secret*.json from Google Cloud is dropped in the project root.
const googleSync = createGoogleSync({ db, rootDir: __dirname });
if (googleSync.enabled) console.log(`[google] Calendar sync enabled (${path.basename(googleSync.config.file)})`);
else console.log('[google] No client_secret*.json found — Google Calendar sync disabled');

// ── Helpers ────────────────────────────────────────────────────────────
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}

// ── API: state ─────────────────────────────────────────────────────────
// GET /api/state — returns the full app state (matches old JSON file shape)
app.get('/api/state', (req, res) => {
  const employees = db.prepare(
    'SELECT emp_code AS id, name, position FROM employees ORDER BY display_order ASC, emp_code ASC'
  ).all();

  const shiftRows = db.prepare('SELECT emp_code, date_key, value FROM shifts').all();
  const shifts = {};
  for (const row of shiftRows) {
    if (!shifts[row.emp_code]) shifts[row.emp_code] = {};
    shifts[row.emp_code][row.date_key] = row.value;
  }

  const minHoursByMonth = getSetting('minHoursByMonth', {});
  const rules = getSetting('rules', null);
  const lastViewMonth = getSetting('lastViewMonth', null);

  res.json({
    employees,
    shifts,
    minHoursByMonth,
    rules,
    lastViewMonth,
    googleEnabled: googleSync.enabled,
    googleLinks: googleSync.linksSummary(),
  });
});

// ── API: shifts ────────────────────────────────────────────────────────
// PUT /api/shifts — bulk upsert of shift cells. Body: { entries: [{empCode, dateKey, value}], deletes: [{empCode, dateKey}] }
app.put('/api/shifts', (req, res) => {
  const { entries = [], deletes = [] } = req.body || {};
  const ins = db.prepare(`
    INSERT INTO shifts (emp_code, date_key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(emp_code, date_key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  const del = db.prepare('DELETE FROM shifts WHERE emp_code = ? AND date_key = ?');

  db.exec('BEGIN');
  try {
    for (const e of entries) ins.run(e.empCode, e.dateKey, e.value);
    for (const d of deletes) del.run(d.empCode, d.dateKey);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }
  googleSync.queue([...entries.map(e => e.empCode), ...deletes.map(d => d.empCode)]);
  res.json({ ok: true, written: entries.length, deleted: deletes.length });
});

// ── API: employees ─────────────────────────────────────────────────────
// PUT /api/employees — replace the entire employee list (used for reorder & bulk import)
app.put('/api/employees', (req, res) => {
  const { employees = [] } = req.body || {};
  const ins = db.prepare(`
    INSERT INTO employees (emp_code, name, position, display_order, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(emp_code) DO UPDATE SET
      name = excluded.name,
      position = excluded.position,
      display_order = excluded.display_order,
      updated_at = CURRENT_TIMESTAMP
  `);
  db.exec('BEGIN');
  try {
    employees.forEach((emp, idx) => {
      ins.run(emp.id, emp.name, emp.position || null, idx);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true, count: employees.length });
});

// DELETE /api/employees/:code — also removes their shifts
app.delete('/api/employees/:code', (req, res) => {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM shifts WHERE emp_code = ?').run(req.params.code);
    db.prepare('DELETE FROM employees WHERE emp_code = ?').run(req.params.code);
    googleSync.forget(req.params.code);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true });
});

// ── API: settings (rules, minHoursByMonth, lastViewMonth) ──────────────
app.put('/api/rules', (req, res) => {
  setSetting('rules', req.body);
  res.json({ ok: true });
});
app.put('/api/min-hours', (req, res) => {
  setSetting('minHoursByMonth', req.body);
  res.json({ ok: true });
});
app.put('/api/last-view-month', (req, res) => {
  setSetting('lastViewMonth', req.body);
  res.json({ ok: true });
});

// ── API: full-state import (used by Excel import on the client) ────────
// POST /api/state/import — body: { employees, shifts (sparse map), minHoursByMonth }
// Performs an "Excel wins" merge: adds new employees, overwrites shift cells provided.
app.post('/api/state/import', (req, res) => {
  const { employees = [], shifts = {}, minHoursByMonth = null } = req.body || {};
  const insEmp = db.prepare(`
    INSERT INTO employees (emp_code, name, position, display_order, updated_at)
    VALUES (?, ?, ?, COALESCE((SELECT display_order FROM employees WHERE emp_code = ?), ?), CURRENT_TIMESTAMP)
    ON CONFLICT(emp_code) DO UPDATE SET
      name = excluded.name,
      position = excluded.position,
      updated_at = CURRENT_TIMESTAMP
  `);
  const insShift = db.prepare(`
    INSERT INTO shifts (emp_code, date_key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(emp_code, date_key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  db.exec('BEGIN');
  try {
    employees.forEach((emp, idx) => {
      insEmp.run(emp.id, emp.name, emp.position || null, emp.id, idx);
    });
    let shiftCount = 0;
    for (const empCode of Object.keys(shifts)) {
      for (const dateKey of Object.keys(shifts[empCode])) {
        insShift.run(empCode, dateKey, shifts[empCode][dateKey]);
        shiftCount++;
      }
    }
    if (minHoursByMonth && typeof minHoursByMonth === 'object') {
      const existing = getSetting('minHoursByMonth', {});
      setSetting('minHoursByMonth', { ...existing, ...minHoursByMonth });
    }
    db.exec('COMMIT');
    googleSync.queue(Object.keys(shifts));
    res.json({ ok: true, employees: employees.length, shifts: shiftCount });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// ── API: Google Calendar sync ──────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function googlePage(title, body, ok) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:Sarabun,system-ui,sans-serif;background:#f4f6fa;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:14px;padding:28px 32px;max-width:460px;box-shadow:0 10px 36px rgba(0,0,0,.12)}
h1{font-size:20px;margin:0 0 12px;color:${ok ? '#1b7f3b' : '#b3261e'}}p{margin:8px 0;line-height:1.5;color:#333}small{color:#777}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1>${body}</div></body></html>`;
}
function googleDisabled(res) {
  return res.status(503).json({ error: 'Google Calendar sync is not configured (no client_secret*.json)' });
}

// GET /api/google/connect/:code — starts OAuth (redirects to Google's consent page).
// Google sends the browser back to http://localhost:3012/api/google/callback. On the
// scheduler PC that just works; on any other PC the page fails to load and the
// user pastes the URL from the address bar into POST /api/google/complete.
app.get('/api/google/connect/:code', (req, res) => {
  if (!googleSync.enabled) return googleDisabled(res);
  const emp = db.prepare('SELECT emp_code FROM employees WHERE emp_code = ?').get(req.params.code);
  if (!emp) return res.status(404).json({ error: 'unknown employee' });
  res.redirect(googleSync.connectUrl(emp.emp_code));
});

// POST /api/google/complete { empCode, input } — finish OAuth from a pasted callback URL / code
app.post('/api/google/complete', async (req, res) => {
  if (!googleSync.enabled) return googleDisabled(res);
  const { empCode, input } = req.body || {};
  const { code, state, error } = googleSync.parsePastedCallback(input);
  if (error) return res.status(400).json({ error: `Google ไม่ได้อนุญาต (${error})` });
  try {
    const { emp, email } = await googleSync.handleCallback({ code, state, empCode });
    res.json({ ok: true, empCode: emp.emp_code, email });
  } catch (e) {
    console.error('[google] complete failed:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// GET /api/google/callback — Google redirects here after consent.
app.get('/api/google/callback', async (req, res) => {
  if (!googleSync.enabled) return googleDisabled(res);
  const { code, state, error } = req.query;
  if (error || !code) {
    return res.status(400).send(googlePage('ยกเลิกการเชื่อมต่อ',
      `<p>ไม่ได้รับอนุญาตจาก Google (${escapeHtml(error || 'no code')})</p><p>ปิดหน้านี้แล้วลองใหม่ได้จากโปรแกรมจัดตารางเวร</p>`, false));
  }
  try {
    const { emp, email } = await googleSync.handleCallback({ code, state });
    res.send(googlePage('เชื่อมต่อ Google Calendar สำเร็จ',
      `<p><b>${escapeHtml(emp.name)}</b>${email ? ` (${escapeHtml(email)})` : ''}</p>
       <p>ปฏิทิน "ตารางเวร IICS" จะปรากฏใน Google Calendar ของคุณภายในไม่กี่วินาที และจะอัปเดตอัตโนมัติทุกครั้งที่ตารางเวรเปลี่ยน</p>
       <p><small>ปิดหน้านี้ได้เลย — ถ้าใช้เครื่องส่วนกลาง อย่าลืมออกจากระบบ Google ในเบราว์เซอร์นี้</small></p>`, true));
  } catch (e) {
    console.error('[google] callback failed:', e.message);
    res.status(500).send(googlePage('เชื่อมต่อไม่สำเร็จ', `<p>${escapeHtml(e.message)}</p>`, false));
  }
});

// GET /api/google/links — connection status per employee (polled by the sync modal)
app.get('/api/google/links', (req, res) => {
  res.json({ enabled: googleSync.enabled, links: googleSync.linksSummary() });
});

// POST /api/google/resync/:code — full re-push (also cleans stray events)
app.post('/api/google/resync/:code', (req, res) => {
  if (!googleSync.enabled) return googleDisabled(res);
  googleSync.queue([req.params.code], { full: true });
  res.json({ ok: true });
});

// DELETE /api/google/link/:code?deleteCalendar=1 — disconnect
app.delete('/api/google/link/:code', async (req, res) => {
  if (!googleSync.enabled) return googleDisabled(res);
  try {
    await googleSync.disconnect(req.params.code, { deleteCalendar: req.query.deleteCalendar === '1' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Optimizer (Python CP-SAT subprocess) ──────────────────────────────
function monthKeyOf(year, month) {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function computeCarryOver(empCodes, year, month, cap) {
  // For each employee, count consecutive non-OFF/non-R shifts ending at
  // the day before this month begins. Looks back through the previous month.
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const prevKey = monthKeyOf(prevYear, prevMonth);
  const rows = db.prepare(`
    SELECT emp_code, date_key, value FROM shifts
    WHERE date_key LIKE ? AND emp_code IN (${empCodes.map(() => '?').join(',') || "''"})
    ORDER BY date_key DESC
  `).all(`${prevKey}-%`, ...empCodes);
  const byEmp = {};
  for (const row of rows) {
    if (!byEmp[row.emp_code]) byEmp[row.emp_code] = [];
    byEmp[row.emp_code].push(row);
  }
  const carry = {};
  for (const eid of empCodes) {
    let consec = 0;
    const list = byEmp[eid] || [];
    for (const r of list) {
      const isWork = r.value && r.value !== 'OFF' && r.value !== 'R';
      if (isWork) consec++;
      else break;
      if (consec > cap + 5) break;
    }
    carry[eid] = consec;
  }
  return carry;
}

// POST /api/schedule/optimize { year, month } → optimized schedule
app.post('/api/schedule/optimize', async (req, res) => {
  const { year, month } = req.body || {};
  if (year == null || month == null) {
    return res.status(400).json({ status: 'error', message: 'year and month required' });
  }

  const rules = getSetting('rules', null);
  if (!rules) {
    return res.status(400).json({ status: 'error', message: 'No rules configured. Set rules in the app first.' });
  }
  const minHoursByMonth = getSetting('minHoursByMonth', {});
  const mKey = monthKeyOf(year, month);
  const minHours = minHoursByMonth[mKey] || 168;

  const employees = db.prepare(
    'SELECT emp_code AS id, name FROM employees ORDER BY display_order ASC, emp_code ASC'
  ).all();
  if (!employees.length) {
    return res.status(400).json({ status: 'error', message: 'No employees in roster.' });
  }

  // userSet = existing shifts for this month (the optimizer treats them as fixed)
  const monthShifts = db.prepare(
    `SELECT emp_code, date_key, value FROM shifts WHERE date_key LIKE ?`
  ).all(`${mKey}-%`);
  const userSet = {};
  for (const r of monthShifts) {
    if (!userSet[r.emp_code]) userSet[r.emp_code] = {};
    userSet[r.emp_code][r.date_key] = r.value;
  }

  const cap = rules.global?.maxConsecutiveWorkdays || 5;
  const carryOver = computeCarryOver(employees.map(e => e.id), year, month, cap);

  const payload = JSON.stringify({
    year, month, employees, userSet, rules, minHours, carryOver
  });

  const scriptPath = path.join(__dirname, 'python', 'optimizer.py');
  let out = '', err = '';
  let resolved = false;
  const finish = (status, body) => {
    if (resolved) return;
    resolved = true;
    res.status(status).json(body);
  };

  if (!PYTHON_CMD) {
    return finish(500, {
      status: 'error',
      message: 'No Python interpreter found on this PC. ' +
               'Install Python from python.org or the Microsoft Store, then run: pip install ortools',
    });
  }

  let py;
  try {
    py = spawnOptimizer(scriptPath);
  } catch (e) {
    console.error('[optimize] spawn threw:', e);
    return finish(500, {
      status: 'error',
      message: `Could not spawn Python (${PYTHON_CMD}): ${e.message}`,
    });
  }
  console.log(`[optimize] Running optimizer for ${year}-${String(month+1).padStart(2,'0')} (${PYTHON_CMD})`);

  py.stdout.on('data', d => { out += d.toString(); });
  py.stderr.on('data', d => {
    const s = d.toString();
    err += s;
    // Mirror Python stderr to server console so the launcher log shows it.
    process.stderr.write(`[optimize/py] ${s}`);
  });
  py.on('error', e => {
    console.error(`[optimize] Python process error:`, e);
    finish(500, {
      status: 'error',
      message: `Python process error (${PYTHON_CMD}): ${e.message}. ` +
               `Verify ortools is installed: ${PYTHON_CMD} -m pip install ortools`,
    });
  });
  py.on('close', code => {
    if (code !== 0 && !out.trim()) {
      return finish(500, { status: 'error', message: `Python exited ${code}\n${err.slice(0, 1000)}` });
    }
    try {
      const result = JSON.parse(out.trim());
      finish(200, result);
    } catch (e) {
      finish(500, {
        status: 'error',
        message: `Bad JSON from optimizer: ${e.message}\nStderr: ${err.slice(0, 500)}\nStdout: ${out.slice(0, 500)}`
      });
    }
  });

  py.stdin.write(payload);
  py.stdin.end();
});

// ── Start ──────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`Shift scheduler running at http://localhost:${PORT}`);
  console.log(`Teammates on your LAN: http://<your-pc-ip>:${PORT}`);
});
