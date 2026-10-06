const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  // Kept as-is for calls that act for this viewer, e.g. the platform's
  // members API, which is called with the caller's own token.
  req.userToken = typeof token === 'string' && token ? token : null;
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Weeks run Monday to Sunday, in UTC, and totals reset each week. The
// Monday that starts the week a moment falls in:
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}
function mondayOf(d) {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}

// The club's roster: everyone in the Homeroom project, from the platform's
// members API — never "who has opened the app". Called with this request's
// user token and cached for a minute; on any failure (the platform's check
// runner, for one, is not a member) the board degrades to runners known
// from its own tables instead of failing the page.
const PLATFORM_API_URL = (process.env.USERNODE_PLATFORM_API_V1_URL
  || process.env.USERNODE_PLATFORM_API_URL || '').replace(/\/+$/, '');
const rosterCache = { at: 0, members: null };

async function fetchRoster(userToken) {
  if (!PLATFORM_API_URL || !userToken) return null;
  if (rosterCache.members && Date.now() - rosterCache.at < 60_000) return rosterCache.members;
  const headers = { 'x-usernode-user-token': userToken };
  if (!IS_STAGING && process.env.USERNODE_LLM_PROXY_TOKEN) {
    headers['x-usernode-app-token'] = process.env.USERNODE_LLM_PROXY_TOKEN;
  }
  try {
    const upstream = await fetch(PLATFORM_API_URL + '/members?limit=100', { headers });
    if (!upstream.ok) return null;
    const data = await upstream.json();
    const list = Array.isArray(data) ? data : (Array.isArray(data.members) ? data.members : []);
    const members = list
      .map((m) => ({ id: Number(m.id), username: String(m.username || m.name || '') }))
      .filter((m) => Number.isFinite(m.id) && m.id > 0 && m.username);
    rosterCache.at = Date.now();
    rosterCache.members = members;
    return members;
  } catch {
    return null;
  }
}

// The week snapshot the board renders: who is in the club, their miles this
// week and their goal, plus the three previous weeks. Reads must work for a
// guest too, so nothing here assumes req.user.
async function buildLeaderboard(req) {
  const weekStart = fmtDate(mondayOf(req.now));
  const weekEnd = addDays(weekStart, 6);
  const recentStarts = [-7, -14, -21].map((n) => addDays(weekStart, n));

  const [roster, totals, goals, recent] = await Promise.all([
    fetchRoster(req.userToken),
    pool.query('SELECT user_id, username, miles FROM weekly_totals WHERE week_start = $1', [weekStart]),
    pool.query('SELECT user_id, username, goal_miles FROM weekly_goals'),
    pool.query('SELECT user_id, week_start::text AS week_start, miles FROM weekly_totals WHERE week_start = ANY($1::date[])', [recentStarts]),
  ]);

  // The club is the roster plus anyone the app already knows about: a
  // member who has never run shows 0.0, and a runner the roster left out
  // still shows with their miles.
  const runners = new Map();
  const add = (id, username) => {
    if (!runners.has(id)) runners.set(id, { user_id: id, username, miles: 0, goal: null });
    return runners.get(id);
  };
  for (const m of roster || []) add(m.id, m.username);
  for (const row of totals.rows) add(row.user_id, row.username).miles = Number(row.miles);
  for (const row of goals.rows) add(row.user_id, row.username).goal = Number(row.goal_miles);

  const runnerList = [...runners.values()]
    .sort((a, b) => b.miles - a.miles || a.username.localeCompare(b.username));

  const byWeek = new Map();
  for (const row of recent.rows) {
    if (!byWeek.has(row.week_start)) byWeek.set(row.week_start, []);
    byWeek.get(row.week_start).push({ user_id: row.user_id, miles: Number(row.miles) });
  }

  return {
    viewer_id: req.user ? req.user.id : null,
    week: { start: weekStart, end: weekEnd },
    runners: runnerList,
    recent_weeks: recentStarts.map((ws) => ({
      week_start: ws,
      totals: (byWeek.get(ws) || []).sort((a, b) => b.miles - a.miles),
    })),
  };
}

app.get('/api/leaderboard', async (req, res) => {
  try {
    res.json(await buildLeaderboard(req));
  } catch (err) {
    console.warn('leaderboard failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// Log a run: miles for yourself, an optional note, and the day it happened.
// The date comes pre-filled with today and can be moved to a past day, so a
// Sunday run can be logged on Monday — but never into the future, and not
// more than a year back.
app.post('/api/runs', async (req, res) => {
  try {
    const body = req.body || {};
    const miles = Number(body.miles);
    if (!Number.isFinite(miles) || miles <= 0 || miles > 500) {
      return res.status(400).json({ error: 'Enter a distance between 0 and 500 miles' });
    }
    const note = body.note == null ? '' : String(body.note).trim();
    if (note.length > 200) {
      return res.status(400).json({ error: 'Keep the note to 200 characters or fewer' });
    }
    const today = fmtDate(req.now);
    let ranOn = today;
    let ranOnDate = req.now;
    if (body.date != null && body.date !== '') {
      const d = String(body.date);
      const parsed = new Date(d + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(parsed.getTime()) || fmtDate(parsed) !== d) {
        return res.status(400).json({ error: 'Enter a real date' });
      }
      if (d > today) return res.status(400).json({ error: 'The date cannot be in the future' });
      if (d < addDays(today, -365)) {
        return res.status(400).json({ error: 'The date cannot be more than a year old' });
      }
      ranOn = d;
      ranOnDate = parsed;
    }
    const weekStart = fmtDate(mondayOf(ranOnDate));

    // The run and its week's total are written together: if either fails,
    // neither happens.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO runs (user_id, username, miles, note, ran_on) VALUES ($1, $2, $3, $4, $5)`,
        [req.user.id, req.user.username, miles, note || null, ranOn]
      );
      await client.query(
        `INSERT INTO weekly_totals (user_id, week_start, username, miles)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, week_start)
         DO UPDATE SET miles = weekly_totals.miles + EXCLUDED.miles, username = EXCLUDED.username`,
        [req.user.id, weekStart, req.user.username, miles]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    // One round trip: answer with the refreshed week so the page can
    // re-render straight from the response.
    res.status(201).json({ ok: true, logged: miles, ...(await buildLeaderboard(req)) });
  } catch (err) {
    console.warn('log run failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// Each runner picks their own weekly mile goal; the strip fills toward it.
// Saving overwrites it and applies from then on — past weeks are not
// rewritten.
app.post('/api/goals', async (req, res) => {
  try {
    const goal = Number((req.body || {}).goal_miles);
    if (!Number.isFinite(goal) || goal <= 0 || goal > 1000) {
      return res.status(400).json({ error: 'Enter a goal between 0 and 1000 miles' });
    }
    await pool.query(
      `INSERT INTO weekly_goals (user_id, username, goal_miles) VALUES ($1, $2, $3)
       ON CONFLICT (user_id)
       DO UPDATE SET goal_miles = EXCLUDED.goal_miles, username = EXCLUDED.username, updated_at = NOW()`,
      [req.user.id, req.user.username, goal]
    );
    res.json({ ok: true });
  } catch (err) {
    console.warn('save goal failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/sunday-run-club-63e7b7/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/sunday-run-club-63e7b7/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Staging seed: obviously fake runners and runs so the populated board can
// be seen before anyone logs anything. Idempotent (fixed ids, ON CONFLICT
// DO NOTHING) and a strict no-op in production. It never attributes
// anything to the visitor: only these fixed fake identities.
async function seedStaging() {
  const demo = [
    { id: 910001, username: 'Staging demo Ada', goal: 20 },
    { id: 910002, username: 'Staging demo Ben', goal: 15 },
    { id: 910003, username: 'Staging demo Priya', goal: 25 },
  ];
  for (const r of demo) {
    await pool.query(
      `INSERT INTO weekly_goals (user_id, username, goal_miles) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [r.id, r.username, r.goal]
    );
  }
  const now = new Date();
  const weekStart = fmtDate(mondayOf(now));
  const dow = (now.getUTCDay() + 6) % 7; // 0 = Monday
  // [runner, weeks back (0 = this week), day offset in the week, miles]
  const plan = [
    [0, 0, Math.min(2, dow), 6.2], [0, 0, Math.min(5, dow), 4.0],
    [0, 1, 2, 8.0],
    [0, 2, 1, 10.2], [0, 2, 5, 8.0],
    [0, 3, 3, 7.5], [0, 3, 6, 7.5],
    [1, 0, Math.min(3, dow), 9.0],
    [1, 1, 4, 12.0],
    [1, 2, 2, 9.5],
    [1, 3, 5, 11.0],
    [2, 0, Math.min(1, dow), 14.5],
    [2, 1, 1, 4.5],
    [2, 3, 2, 6.0],
  ];
  let runId = 911001;
  for (const [runnerIdx, weeksBack, dayOffset, miles] of plan) {
    const ranOn = weeksBack === 0
      // Never in the future: a mid-week run lands on a day that has happened.
      ? addDays(weekStart, Math.min(dayOffset, dow))
      : addDays(addDays(weekStart, -7 * weeksBack), dayOffset);
    const r = demo[runnerIdx];
    await pool.query(
      `INSERT INTO runs (id, user_id, username, miles, note, ran_on) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [runId++, r.id, r.username, miles, null, ranOn]
    );
  }
  // Totals are derived from the runs, so they always agree with them.
  await pool.query(`
    INSERT INTO weekly_totals (user_id, week_start, username, miles)
    SELECT user_id,
           ran_on - ((EXTRACT(DOW FROM ran_on)::int + 6) % 7) AS week_start,
           MAX(username), SUM(miles)
    FROM runs
    WHERE user_id BETWEEN 910001 AND 910003
    GROUP BY user_id, week_start
    ON CONFLICT (user_id, week_start) DO NOTHING
  `);
}

async function start() {
  // All three tables are public: their rows are club-visible content —
  // usernames and mile numbers, the same data the board shows every member.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      miles NUMERIC(6,2) NOT NULL,
      note VARCHAR(200),
      ran_on DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS weekly_totals (
      user_id INTEGER NOT NULL,
      week_start DATE NOT NULL,
      username VARCHAR(255) NOT NULL,
      miles NUMERIC(8,2) NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, week_start)
    );
    CREATE TABLE IF NOT EXISTS weekly_goals (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      goal_miles NUMERIC(6,2) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  if (IS_STAGING) {
    try {
      await seedStaging();
    } catch (err) {
      // Seed data must never keep the app from booting.
      console.warn('staging seed failed: ' + err.message);
    }
  }
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
