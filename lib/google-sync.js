// Google Calendar push-sync (per employee, opt-in).
//
// Outbound HTTPS only — nothing is opened on this PC. Each employee gives the
// app permission once (OAuth on the scheduler PC itself, because Google only
// allows a plain http://localhost redirect). We keep their refresh token in
// SQLite and, whenever their shifts change, push create/update/delete calls
// into a secondary calendar ("ตารางเวร IICS") that the app creates in their
// account. Event IDs are deterministic (emp_code + date), so re-pushing is
// idempotent and clearing a cell deletes the matching event.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CAL_API = 'https://www.googleapis.com/calendar/v3';

// calendar.app.created = "make secondary calendars and manage events on
// them" — the least-privilege scope that still lets us keep the shifts in a
// calendar the user can hide with one checkbox. Override with GOOGLE_SCOPE
// (e.g. https://www.googleapis.com/auth/calendar) if consent ever rejects it.
const CALENDAR_SCOPE = process.env.GOOGLE_SCOPE || 'https://www.googleapis.com/auth/calendar.app.created';
const SCOPES = ['openid', 'email', CALENDAR_SCOPE].join(' ');

const CALENDAR_NAME = 'ตารางเวร IICS';
const TIMEZONE = 'Asia/Bangkok';
const ALL_DAY_NAMES = { R: 'คำขอ (Request)', V: 'ลาพักร้อน (Vacation)', E: 'กิจกรรม (Event)' };

const DEBOUNCE_MS = 1500;          // coalesce rapid cell edits into one push
const RETRY_FAILED_EVERY_MS = 10 * 60 * 1000;

// ── Config (client_secret*.json from Google Cloud console) ─────────────
function loadConfig(rootDir) {
  let file = process.env.GOOGLE_CLIENT_SECRET_FILE;
  if (!file) {
    const found = fs.readdirSync(rootDir).find(f => /^client_secret.*\.json$/i.test(f));
    if (found) file = path.join(rootDir, found);
  }
  if (!file || !fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = raw.web || raw.installed;
  if (!c || !c.client_id || !c.client_secret) {
    console.warn(`[google] ${file} has no web.client_id / client_secret — sync disabled`);
    return null;
  }
  const redirectUri = (c.redirect_uris && c.redirect_uris[0]) || 'http://localhost:3012/api/google/callback';
  return { clientId: c.client_id, clientSecret: c.client_secret, redirectUri, file };
}

// ── Event shape (mirrors exportEmployeeIcs in public/index.html) ────────
function eventIdFor(empCode, dateKey) {
  // Google event ids must match [a-v0-9]{5,1024}; hex fits.
  return 'iics' + crypto.createHash('sha1').update(`${empCode}|${dateKey}`).digest('hex');
}

function addDays(dateKey, n) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Returns a Google event body, or null when the value produces no event (OFF / unknown).
function buildEvent(emp, dateKey, value) {
  if (!value || value === 'OFF') return null;
  const base = {
    id: eventIdFor(emp.emp_code, dateKey),
    status: 'confirmed',
    transparency: 'opaque',
    extendedProperties: { private: { iics: '1', empCode: emp.emp_code, dateKey } },
  };
  if (ALL_DAY_NAMES[value]) {
    return {
      ...base,
      summary: ALL_DAY_NAMES[value],
      start: { date: dateKey },
      end: { date: addDays(dateKey, 1) },
    };
  }
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const pad = n => String(n).padStart(2, '0');
  const startMin = +m[1] * 60 + +m[2];
  const endMin = +m[3] * 60 + +m[4];
  const endDate = endMin <= startMin ? addDays(dateKey, 1) : dateKey;  // overnight guard
  return {
    ...base,
    summary: `เวร ${value}`,
    description: `${emp.name}${emp.position ? ' (' + emp.position + ')' : ''}`,
    start: { dateTime: `${dateKey}T${pad(m[1])}:${m[2]}:00`, timeZone: TIMEZONE },
    end: { dateTime: `${endDate}T${pad(m[3])}:${m[4]}:00`, timeZone: TIMEZONE },
  };
}

// ── Module ─────────────────────────────────────────────────────────────
function createGoogleSync({ db, rootDir, log = console }) {
  const config = loadConfig(rootDir);

  db.exec(`
    CREATE TABLE IF NOT EXISTS google_links (
      emp_code      TEXT PRIMARY KEY,
      email         TEXT,
      refresh_token TEXT NOT NULL,
      calendar_id   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'ok',   -- 'ok' | 'reauth' (token revoked/expired)
      last_sync_at  DATETIME,
      last_error    TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- What we have already pushed, so a save only touches the cells that changed.
    CREATE TABLE IF NOT EXISTS google_events (
      emp_code TEXT NOT NULL,
      date_key TEXT NOT NULL,
      value    TEXT NOT NULL,
      PRIMARY KEY (emp_code, date_key)
    );
  `);

  const q = {
    getLink: db.prepare('SELECT * FROM google_links WHERE emp_code = ?'),
    allLinks: db.prepare('SELECT emp_code, email, status, last_sync_at, last_error FROM google_links'),
    allLinkCodes: db.prepare('SELECT emp_code FROM google_links'),
    upsertLink: db.prepare(`
      INSERT INTO google_links (emp_code, email, refresh_token, calendar_id, status, last_error)
      VALUES (?, ?, ?, ?, 'ok', NULL)
      ON CONFLICT(emp_code) DO UPDATE SET
        email = excluded.email, refresh_token = excluded.refresh_token,
        calendar_id = excluded.calendar_id, status = 'ok', last_error = NULL
    `),
    setResult: db.prepare(`UPDATE google_links SET status = ?, last_error = ?, last_sync_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_sync_at END WHERE emp_code = ?`),
    deleteLink: db.prepare('DELETE FROM google_links WHERE emp_code = ?'),
    getEmp: db.prepare('SELECT emp_code, name, position FROM employees WHERE emp_code = ?'),
    shiftsFor: db.prepare('SELECT date_key, value FROM shifts WHERE emp_code = ?'),
    pushedFor: db.prepare('SELECT date_key, value FROM google_events WHERE emp_code = ?'),
    setPushed: db.prepare('INSERT INTO google_events (emp_code, date_key, value) VALUES (?, ?, ?) ON CONFLICT(emp_code, date_key) DO UPDATE SET value = excluded.value'),
    delPushed: db.prepare('DELETE FROM google_events WHERE emp_code = ? AND date_key = ?'),
    clearPushed: db.prepare('DELETE FROM google_events WHERE emp_code = ?'),
  };

  // ── OAuth ────────────────────────────────────────────────────────────
  const pendingStates = new Map();   // state → { empCode, expires }

  function connectUrl(empCode) {
    const state = crypto.randomBytes(16).toString('base64url');
    pendingStates.set(state, { empCode, expires: Date.now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',           // always get a refresh_token, even on re-connect
      state,
    });
    return `${AUTH_URL}?${params}`;
  }

  async function tokenRequest(form) {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(body.error_description || body.error || `token endpoint ${r.status}`);
      err.code = body.error;
      throw err;
    }
    return body;
  }

  function emailFromIdToken(idToken) {
    try {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
      return payload.email || null;
    } catch { return null; }
  }

  // Accepts what a user pastes after consent — the full failed-redirect URL
  // (http://localhost:3012/api/google/callback?code=…&state=…) or a bare code.
  function parsePastedCallback(text) {
    const s = String(text || '').trim();
    if (!s) return {};
    try {
      const u = new URL(s);
      return { code: u.searchParams.get('code'), state: u.searchParams.get('state'), error: u.searchParams.get('error') };
    } catch {
      return { code: s.replace(/^code=/, '') };
    }
  }

  // Completes the OAuth dance: exchanges the code, creates the calendar, stores the link.
  // `state` identifies the employee for the automatic localhost callback; a pasted
  // bare code (no state) is tied to the employee whose modal it was pasted into.
  async function handleCallback({ code, state, empCode = null }) {
    let targetCode = empCode;
    if (state) {
      const pending = pendingStates.get(state);
      pendingStates.delete(state);
      if (!pending || pending.expires < Date.now()) throw new Error('ลิงก์หมดอายุ กรุณากด "เชื่อมต่อ Google" ใหม่');
      targetCode = pending.empCode;
    }
    if (!code) throw new Error('ไม่พบรหัสยืนยัน (code) ในข้อความที่วาง');
    if (!targetCode) throw new Error('ไม่ทราบว่าเป็นของพนักงานคนไหน');
    const emp = q.getEmp.get(targetCode);
    if (!emp) throw new Error(`ไม่พบพนักงาน ${targetCode}`);

    const tok = await tokenRequest({
      code, client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, grant_type: 'authorization_code',
    });
    if (!tok.refresh_token) throw new Error('Google ไม่ได้ส่ง refresh token กลับมา กรุณาลองใหม่');
    const email = tok.id_token ? emailFromIdToken(tok.id_token) : null;

    // Reuse the existing calendar when re-connecting the same person, else create one.
    const existing = q.getLink.get(emp.emp_code);
    let calendarId = null;
    if (existing) {
      const r = await fetch(`${CAL_API}/calendars/${encodeURIComponent(existing.calendar_id)}`, {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      if (r.ok) calendarId = existing.calendar_id;
    }
    if (!calendarId) {
      const r = await fetch(`${CAL_API}/calendars`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: CALENDAR_NAME, timeZone: TIMEZONE }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`สร้างปฏิทินไม่สำเร็จ: ${body.error?.message || r.status}`);
      calendarId = body.id;
    }

    q.upsertLink.run(emp.emp_code, email, tok.refresh_token, calendarId);
    q.clearPushed.run(emp.emp_code);           // fresh calendar (or unknown state) → push everything
    accessTokens.set(emp.emp_code, { token: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 });
    queue([emp.emp_code], { full: true });
    return { emp, email };
  }

  // ── Access tokens ────────────────────────────────────────────────────
  const accessTokens = new Map();   // empCode → { token, expires }

  async function accessTokenFor(link) {
    const cached = accessTokens.get(link.emp_code);
    if (cached && cached.expires > Date.now()) return cached.token;
    try {
      const tok = await tokenRequest({
        refresh_token: link.refresh_token, client_id: config.clientId,
        client_secret: config.clientSecret, grant_type: 'refresh_token',
      });
      accessTokens.set(link.emp_code, { token: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 });
      return tok.access_token;
    } catch (e) {
      if (e.code === 'invalid_grant') {
        // Token revoked by the user, or expired (7 days if the OAuth app is still in "Testing").
        const err = new Error('การเชื่อมต่อหมดอายุหรือถูกยกเลิก กรุณาเชื่อมต่อ Google ใหม่');
        err.reauth = true;
        throw err;
      }
      throw e;
    }
  }

  // ── Calendar API calls with retry ───────────────────────────────────
  async function calApi(link, method, urlPath, body, attempt = 0) {
    const token = await accessTokenFor(link);
    const r = await fetch(`${CAL_API}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return { status: 204 };
    const json = await r.json().catch(() => ({}));
    if (r.ok) return { status: r.status, body: json };
    const retryable = r.status === 429 || r.status >= 500 ||
      (r.status === 403 && /rateLimit|usageLimits/i.test(JSON.stringify(json)));
    if (retryable && attempt < 3) {
      await new Promise(res => setTimeout(res, 1000 * 2 ** attempt));
      return calApi(link, method, urlPath, body, attempt + 1);
    }
    if (r.status === 401) accessTokens.delete(link.emp_code);
    const err = new Error(json.error?.message || `Google API ${r.status}`);
    err.status = r.status;
    return Promise.reject(err);
  }

  async function upsertEvent(link, ev) {
    const cal = encodeURIComponent(link.calendar_id);
    try {
      await calApi(link, 'POST', `/calendars/${cal}/events`, ev);
    } catch (e) {
      // 409 = id already exists (live or previously deleted) → update resurrects it.
      if (e.status !== 409) throw e;
      await calApi(link, 'PUT', `/calendars/${cal}/events/${ev.id}`, ev);
    }
  }

  async function deleteEvent(link, eventId) {
    const cal = encodeURIComponent(link.calendar_id);
    try {
      await calApi(link, 'DELETE', `/calendars/${cal}/events/${eventId}`);
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;   // already gone
    }
  }

  // ── Sync ─────────────────────────────────────────────────────────────
  const timers = new Map();   // empCode → debounce timer
  const running = new Map();  // empCode → { promise, again, full }

  // Queue a push for these employees (no-op for anyone not connected).
  function queue(empCodes, { full = false } = {}) {
    if (!config) return;
    for (const code of new Set(empCodes)) {
      if (!q.getLink.get(code)) continue;
      const cur = running.get(code);
      if (cur) { cur.again = true; cur.full = cur.full || full; continue; }
      clearTimeout(timers.get(code)?.t);
      const prevFull = timers.get(code)?.full || false;
      timers.set(code, { full: full || prevFull, t: setTimeout(() => {
        const { full: f } = timers.get(code);
        timers.delete(code);
        run(code, f);
      }, DEBOUNCE_MS) });
    }
  }

  function run(code, full) {
    const slot = { again: false, full: false };
    slot.promise = syncEmployee(code, full)
      .catch(e => log.error(`[google] sync ${code} failed:`, e.message))
      .finally(() => {
        running.delete(code);
        if (slot.again) queue([code], { full: slot.full });
      });
    running.set(code, slot);
    return slot.promise;
  }

  async function syncEmployee(empCode, full = false) {
    const link = q.getLink.get(empCode);
    const emp = q.getEmp.get(empCode);
    if (!link || !emp) return;

    try {
      const desired = new Map(q.shiftsFor.all(empCode).map(r => [r.date_key, r.value]));
      let pushed = new Map(q.pushedFor.all(empCode).map(r => [r.date_key, r.value]));

      if (full) {
        // Full resync: forget local bookkeeping and remove any stray events
        // we created that no longer correspond to a shift.
        q.clearPushed.run(empCode);
        pushed = new Map();
        const cal = encodeURIComponent(link.calendar_id);
        let pageToken = null;
        do {
          const params = new URLSearchParams({ maxResults: '2500', showDeleted: 'false', privateExtendedProperty: 'iics=1' });
          if (pageToken) params.set('pageToken', pageToken);
          const { body } = await calApi(link, 'GET', `/calendars/${cal}/events?${params}`);
          for (const ev of body.items || []) {
            const dk = ev.extendedProperties?.private?.dateKey;
            if (!dk || !buildEvent(emp, dk, desired.get(dk))) await deleteEvent(link, ev.id);
          }
          pageToken = body.nextPageToken || null;
        } while (pageToken);
      }

      let created = 0, removed = 0;
      for (const [dk, value] of desired) {
        const ev = buildEvent(emp, dk, value);
        const prev = pushed.get(dk);
        if (!ev) {
          if (prev !== undefined) { await deleteEvent(link, eventIdFor(empCode, dk)); q.delPushed.run(empCode, dk); removed++; }
          continue;
        }
        if (prev === value && !full) continue;
        await upsertEvent(link, ev);
        q.setPushed.run(empCode, dk, value);
        created++;
      }
      for (const dk of pushed.keys()) {
        if (desired.has(dk)) continue;
        await deleteEvent(link, eventIdFor(empCode, dk));
        q.delPushed.run(empCode, dk);
        removed++;
      }

      q.setResult.run('ok', null, 1, empCode);
      if (created || removed || full) log.log(`[google] ${empCode}: pushed ${created}, removed ${removed}${full ? ' (full)' : ''}`);
    } catch (e) {
      if (e.status === 404 && /calendar/i.test(e.message)) {
        // The user deleted our calendar in Google; recreate it on next full sync.
        q.setResult.run('reauth', 'ปฏิทิน "ตารางเวร IICS" ถูกลบใน Google กรุณาเชื่อมต่อใหม่', 0, empCode);
      } else {
        q.setResult.run(e.reauth ? 'reauth' : 'ok', e.message, 0, empCode);
      }
      throw e;
    }
  }

  // Disconnect: optionally delete the calendar in Google, revoke our token, forget the link.
  async function disconnect(empCode, { deleteCalendar = false } = {}) {
    const link = q.getLink.get(empCode);
    if (!link) return;
    clearTimeout(timers.get(empCode)?.t); timers.delete(empCode);
    if (running.has(empCode)) await running.get(empCode).promise;
    if (deleteCalendar) {
      try { await calApi(link, 'DELETE', `/calendars/${encodeURIComponent(link.calendar_id)}`); }
      catch (e) { log.warn(`[google] delete calendar for ${empCode}:`, e.message); }
    }
    try { await fetch(`${REVOKE_URL}?token=${encodeURIComponent(link.refresh_token)}`, { method: 'POST' }); }
    catch (e) { log.warn(`[google] revoke for ${empCode}:`, e.message); }
    accessTokens.delete(empCode);
    q.deleteLink.run(empCode);
    q.clearPushed.run(empCode);
  }

  // Forget a link without touching Google (used when the employee row is deleted).
  function forget(empCode) {
    clearTimeout(timers.get(empCode)?.t); timers.delete(empCode);
    accessTokens.delete(empCode);
    q.deleteLink.run(empCode);
    q.clearPushed.run(empCode);
  }

  function linksSummary() {
    const out = {};
    for (const r of q.allLinks.all()) {
      out[r.emp_code] = { email: r.email, status: r.status, lastSyncAt: r.last_sync_at, lastError: r.last_error };
    }
    return out;
  }

  // Periodically retry anyone whose last push failed (network blip, PC was offline).
  if (config) {
    setInterval(() => {
      const failed = q.allLinks.all().filter(r => r.last_error && r.status === 'ok').map(r => r.emp_code);
      if (failed.length) queue(failed);
    }, RETRY_FAILED_EVERY_MS).unref();
  }

  return {
    enabled: !!config,
    config,
    connectUrl,
    handleCallback,
    parsePastedCallback,
    queue,
    queueAll: (opts) => queue(q.allLinkCodes.all().map(r => r.emp_code), opts),
    disconnect,
    forget,
    linksSummary,
    // exported for tests / debugging
    buildEvent,
    eventIdFor,
  };
}

module.exports = { createGoogleSync, buildEvent, eventIdFor };
