/**
 * mark-status · שרת
 * עמוד סטטוס ציבורי לפי קישור סודי, ומסך ניהול לעורכים מורשים.
 */
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 80;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, idleTimeoutMillis: 30000 });
const q = (text, params) => pool.query(text, params);

// ── עורכים ─────────────────────────────────────────────
// EDITORS="צביקי:סיסמה;אריה:סיסמה;שרוליק:סיסמה"
// לתאימות לאחור: ADMIN_PASSWORD לבד יוצר עורך אחד בשם "מנהל"
const EDITORS = {};
(process.env.EDITORS || '').split(';').map(s => s.trim()).filter(Boolean).forEach(pair => {
  const i = pair.indexOf(':');
  if (i > 0) EDITORS[pair.slice(0, i).trim()] = pair.slice(i + 1);
});
if (process.env.ADMIN_PASSWORD && !Object.keys(EDITORS).length) EDITORS['מנהל'] = process.env.ADMIN_PASSWORD;
if (!Object.keys(EDITORS).length) {
  console.error('לא הוגדרו עורכים. יש להגדיר EDITORS או ADMIN_PASSWORD');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET לא הוגדר, כל הפעלה מחדש תנתק את העורכים');
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
app.use(session({
  name: 'ms.sid',
  store: new pgSession({ pool, schemaName: 'mark_status', tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12,
  },
}));

// עוטף handler אסינכרוני כך ששגיאה לא מפילה את השרת
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const requireAuth = (req, res, next) =>
  req.session?.editor ? next() : res.status(401).json({ error: 'נדרשת התחברות' });

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const STATUSES = ['work', 'wait', 'block', 'done'];
const STATUS_HE = { work: 'בעבודה', wait: 'ממתין', block: 'חסום', done: 'הושלם' };

// בונה UPDATE רק מהשדות שנשלחו בפועל, כך שעדכון חלקי לא מוחק שדות אחרים
function buildUpdate(body, allowed, startIdx = 2) {
  const sets = [], vals = [];
  let i = startIdx;
  for (const col of allowed) {
    if (!Object.prototype.hasOwnProperty.call(body, col)) continue;
    const v = body[col];
    if (col === 'bullets') { sets.push(`bullets=$${i++}::jsonb`); vals.push(JSON.stringify(Array.isArray(v) ? v : [])); }
    else { sets.push(`${col}=$${i++}`); vals.push(v === '' ? null : v); }
  }
  return { sets, vals };
}

// ═══ ציבורי ═══════════════════════════════════════════
app.get('/api/status/:token', h(async (req, res) => {
  const { rows: cl } = await q(
    `SELECT id, name, subtitle, version, logo_url, updated_at FROM mark_status.clients
      WHERE token=$1 AND is_active=TRUE`, [req.params.token]);
  if (!cl.length) return res.status(404).json({ error: 'לא נמצא' });
  const client = cl[0];

  const [items, questions, history, last] = await Promise.all([
    q(`SELECT id,title,description,status,icon,owner,stage,blocker,bullets,updated_at
         FROM mark_status.items WHERE client_id=$1 ORDER BY sort_order, id`, [client.id]),
    q(`SELECT id,title,body,answer,answered_at FROM mark_status.questions WHERE client_id=$1 ORDER BY sort_order, id`, [client.id]),
    q(`SELECT item_title, change, changed_at FROM mark_status.history
        WHERE client_id=$1 ORDER BY changed_at DESC LIMIT 20`, [client.id]),
    q(`SELECT GREATEST(
         (SELECT updated_at FROM mark_status.clients WHERE id=$1),
         COALESCE((SELECT MAX(updated_at) FROM mark_status.items WHERE client_id=$1), 'epoch'),
         COALESCE((SELECT MAX(changed_at) FROM mark_status.history WHERE client_id=$1), 'epoch')
       ) AS at`, [client.id]),
  ]);

  res.set('Cache-Control', 'no-store');
  res.json({
    client: { name: client.name, subtitle: client.subtitle, version: client.version, logo_url: client.logo_url, updated_at: last.rows[0].at },
    items: items.rows, questions: questions.rows, history: history.rows,
  });
}));

// לקוח מעדכן את הלוגו שלו עצמו, מזוהה רק לפי הטוקן הסודי
app.put('/api/status/:token/logo', h(async (req, res) => {
  const logo_url = String(req.body?.logo_url ?? '').trim();
  if (logo_url && !/^https?:\/\//i.test(logo_url)) return res.status(400).json({ error: 'כתובת לא תקינה' });
  if (logo_url.length > 500) return res.status(400).json({ error: 'הכתובת ארוכה מדי' });

  const { rows } = await q(
    `UPDATE mark_status.clients SET logo_url=$1 WHERE token=$2 AND is_active=TRUE RETURNING id, logo_url`,
    [logo_url || null, req.params.token]);
  if (!rows.length) return res.status(404).json({ error: 'לא נמצא' });
  await q(`INSERT INTO mark_status.history (client_id,change) VALUES ($1,$2)`, [rows[0].id, 'עדכן לוגו']);
  res.json({ logo_url: rows[0].logo_url });
}));

// לקוח עונה על שאלה פתוחה, ויכול לערוך את התשובה בכל עת
app.post('/api/status/:token/questions/:qid/answer', h(async (req, res) => {
  const answer = String(req.body?.answer ?? '').trim();
  if (!answer) return res.status(400).json({ error: 'יש להזין תשובה' });
  if (answer.length > 4000) return res.status(400).json({ error: 'התשובה ארוכה מדי' });

  const { rows } = await q(
    `UPDATE mark_status.questions AS qu SET answer=$1, answered_at=NOW()
       FROM mark_status.clients c
      WHERE qu.id=$2 AND qu.client_id=c.id AND c.token=$3 AND c.is_active=TRUE
      RETURNING qu.id, qu.title, qu.body, qu.answer, qu.answered_at, qu.client_id`,
    [answer, req.params.qid, req.params.token]);
  if (!rows.length) return res.status(404).json({ error: 'לא נמצא' });

  await q(`INSERT INTO mark_status.history (client_id,item_title,change) VALUES ($1,$2,$3)`,
    [rows[0].client_id, rows[0].title, 'ענה על שאלה']);
  res.json({ id: rows[0].id, title: rows[0].title, body: rows[0].body, answer: rows[0].answer, answered_at: rows[0].answered_at });
}));

// ═══ התחברות ══════════════════════════════════════════
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (now - a.t > LOGIN_WINDOW_MS) attempts.delete(ip);
}, LOGIN_WINDOW_MS).unref();

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > LOGIN_WINDOW_MS) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: 'יותר מדי ניסיונות. נסה שוב בעוד רבע שעה' });

  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  const expected = EDITORS[name];
  const ok = safeEqual(password, expected ?? crypto.randomBytes(16).toString('hex')) && expected !== undefined;

  if (!ok) { a.n++; attempts.set(ip, a); return res.status(401).json({ error: 'שם או סיסמה שגויים' }); }
  attempts.delete(ip);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'שגיאת שרת' });
    req.session.editor = name;
    res.json({ ok: true, editor: name });
  });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => {
  const editor = req.session?.editor || null;
  res.json({ editor, editors: editor ? Object.keys(EDITORS) : [] });
});

// ═══ ניהול · לקוחות ═══════════════════════════════════
app.get('/api/admin/clients', requireAuth, h(async (_req, res) => {
  const { rows } = await q(
    `SELECT c.*,
       (SELECT COUNT(*)::int FROM mark_status.items i WHERE i.client_id=c.id) AS item_count,
       (SELECT COUNT(*)::int FROM mark_status.items i WHERE i.client_id=c.id AND i.status='done') AS done_count
     FROM mark_status.clients c ORDER BY c.is_active DESC, c.name`);
  res.json(rows);
}));

app.post('/api/admin/clients', requireAuth, h(async (req, res) => {
  const { name, subtitle, version } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'יש להזין שם לקוח' });
  const token = crypto.randomBytes(12).toString('base64url');
  const { rows } = await q(
    `INSERT INTO mark_status.clients (name, subtitle, token, version)
     VALUES ($1,$2,$3,COALESCE($4,'1.0')) RETURNING *`,
    [name.trim(), subtitle || null, token, version || null]);
  res.json(rows[0]);
}));

app.get('/api/admin/clients/:id', requireAuth, h(async (req, res) => {
  const { rows } = await q(
    `SELECT c.*,
       (SELECT COUNT(*)::int FROM mark_status.items i WHERE i.client_id=c.id) AS item_count,
       (SELECT COUNT(*)::int FROM mark_status.items i WHERE i.client_id=c.id AND i.status='done') AS done_count
     FROM mark_status.clients c WHERE c.id=$1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'לא נמצא' });
  res.json(rows[0]);
}));

const TOKEN_RE = /^[A-Za-z0-9_-]{4,64}$/;
app.put('/api/admin/clients/:id', requireAuth, h(async (req, res) => {
  const body = req.body || {};
  if (body.token !== undefined && !TOKEN_RE.test(body.token)) {
    return res.status(400).json({ error: 'פורמט קישור לא תקין (רק אותיות, מספרים, מקף וקו תחתון)' });
  }
  const { sets, vals } = buildUpdate(body, ['name', 'subtitle', 'version', 'logo_url', 'is_active', 'token']);
  let rows;
  try {
    ({ rows } = sets.length
      ? await q(`UPDATE mark_status.clients SET ${sets.join(',')} WHERE id=$1 RETURNING *`, [req.params.id, ...vals])
      : await q(`SELECT * FROM mark_status.clients WHERE id=$1`, [req.params.id]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'הקישור הזה כבר תפוס, נסה קישור אחר' });
    throw e;
  }
  if (!rows.length) return res.status(404).json({ error: 'לא נמצא' });
  res.json(rows[0]);
}));

// יצירת קישור חדש מבטלת את הקודם, למקרה שדלף
app.post('/api/admin/clients/:id/rotate', requireAuth, h(async (req, res) => {
  const token = crypto.randomBytes(12).toString('base64url');
  const { rows } = await q(`UPDATE mark_status.clients SET token=$2 WHERE id=$1 RETURNING *`, [req.params.id, token]);
  if (!rows.length) return res.status(404).json({ error: 'לא נמצא' });
  res.json(rows[0]);
}));

app.delete('/api/admin/clients/:id', requireAuth, h(async (req, res) => {
  await q(`DELETE FROM mark_status.clients WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// ═══ ניהול · כרטיסים ══════════════════════════════════
app.get('/api/admin/clients/:id/items', requireAuth, h(async (req, res) => {
  const [items, questions] = await Promise.all([
    q(`SELECT * FROM mark_status.items WHERE client_id=$1 ORDER BY sort_order, id`, [req.params.id]),
    q(`SELECT * FROM mark_status.questions WHERE client_id=$1 ORDER BY sort_order, id`, [req.params.id]),
  ]);
  res.json({ items: items.rows, questions: questions.rows });
}));

app.post('/api/admin/items', requireAuth, h(async (req, res) => {
  const b = req.body || {};
  if (!b.client_id) return res.status(400).json({ error: 'חסר לקוח' });
  const status = STATUSES.includes(b.status) ? b.status : 'work';
  const { rows } = await q(
    `INSERT INTO mark_status.items
       (client_id,title,description,status,icon,owner,stage,blocker,bullets,sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,
       COALESCE($10,(SELECT COALESCE(MAX(sort_order)+1,0) FROM mark_status.items WHERE client_id=$1)))
     RETURNING *`,
    [b.client_id, b.title || 'כרטיס חדש', b.description || null, status, b.icon || 'circle',
     b.owner || null, b.stage || null, b.blocker || null, JSON.stringify(b.bullets || []), b.sort_order ?? null]);
  await q(`INSERT INTO mark_status.history (client_id,item_id,item_title,change) VALUES ($1,$2,$3,$4)`,
    [b.client_id, rows[0].id, rows[0].title, 'נוסף']);
  res.json(rows[0]);
}));

app.put('/api/admin/items/:id', requireAuth, h(async (req, res) => {
  const b = req.body || {};
  if (b.status !== undefined && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'סטטוס לא תקין' });
  const { rows: before } = await q(`SELECT * FROM mark_status.items WHERE id=$1`, [req.params.id]);
  if (!before.length) return res.status(404).json({ error: 'לא נמצא' });

  const { sets, vals } = buildUpdate(b,
    ['title', 'description', 'status', 'icon', 'owner', 'stage', 'blocker', 'bullets', 'sort_order']);
  if (!sets.length) return res.json(before[0]);

  const { rows } = await q(`UPDATE mark_status.items SET ${sets.join(',')} WHERE id=$1 RETURNING *`,
    [req.params.id, ...vals]);

  if (b.status && b.status !== before[0].status) {
    await q(`INSERT INTO mark_status.history (client_id,item_id,item_title,change) VALUES ($1,$2,$3,$4)`,
      [before[0].client_id, before[0].id, rows[0].title, `עבר ל${STATUS_HE[b.status]}`]);
  }
  res.json(rows[0]);
}));

// שינוי סדר: מקבל מערך מזהים לפי הסדר החדש
app.post('/api/admin/clients/:id/reorder', requireAuth, h(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await c.query(
        `UPDATE mark_status.items SET sort_order=$1 WHERE id=$2 AND client_id=$3 AND sort_order IS DISTINCT FROM $1`,
        [i, ids[i], req.params.id]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  res.json({ ok: true });
}));

app.delete('/api/admin/items/:id', requireAuth, h(async (req, res) => {
  const { rows } = await q(`DELETE FROM mark_status.items WHERE id=$1 RETURNING client_id,title`, [req.params.id]);
  if (rows.length) {
    await q(`INSERT INTO mark_status.history (client_id,item_title,change) VALUES ($1,$2,$3)`,
      [rows[0].client_id, rows[0].title, 'הוסר']);
  }
  res.json({ ok: true });
}));

// ═══ ניהול · שאלות פתוחות ═════════════════════════════
app.post('/api/admin/questions', requireAuth, h(async (req, res) => {
  const b = req.body || {};
  const { rows } = await q(
    `INSERT INTO mark_status.questions (client_id,title,body,sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
    [b.client_id, b.title || 'שאלה חדשה', b.body || null, b.sort_order ?? 0]);
  res.json(rows[0]);
}));

app.put('/api/admin/questions/:id', requireAuth, h(async (req, res) => {
  const { sets, vals } = buildUpdate(req.body || {}, ['title', 'body', 'sort_order']);
  const { rows } = sets.length
    ? await q(`UPDATE mark_status.questions SET ${sets.join(',')} WHERE id=$1 RETURNING *`, [req.params.id, ...vals])
    : await q(`SELECT * FROM mark_status.questions WHERE id=$1`, [req.params.id]);
  res.json(rows[0] || null);
}));

app.delete('/api/admin/questions/:id', requireAuth, h(async (req, res) => {
  await q(`DELETE FROM mark_status.questions WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// ═══ עמודים ═══════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('/s/:token', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));
app.get('/health', h(async (_req, res) => { await q('SELECT 1'); res.json({ ok: true }); }));
app.get('/', (_req, res) => res.redirect('/admin'));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'שגיאת שרת' });
});

// ═══ הפעלה ════════════════════════════════════════════
(async () => {
  try {
    await q('SELECT 1');
    if (process.env.AUTO_MIGRATE !== 'false') {
      await q(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
      console.log('הסכימה מוכנה');
    }
  } catch (e) {
    console.error('בעיה בבסיס הנתונים:', e.message);
  }
  app.listen(PORT, () => console.log(`mark-status פועל על פורט ${PORT} · עורכים: ${Object.keys(EDITORS).join(', ')}`));
})();
