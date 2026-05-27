const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { initDb, queryAll, queryGet, runSql } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'expenses-system-secret-change-in-production';

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ──
function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}
function hasRole(user, role) { return (user.roles || '').split(',').includes(role); }
function requireRole(role) {
  return (req, res, next) => hasRole(req.user, role) ? next() : res.status(403).json({ error: 'Insufficient permissions' });
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = queryGet('SELECT * FROM users WHERE username = ?', [String(username || '').toLowerCase()]);
  if (!user || !user.active) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username, roles: user.roles, full_name: user.full_name }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, roles: user.roles.split(','), must_change_password: !!user.must_change_password } });
});

// ── Generic reference-data CRUD (finance only for writes) ──
const REF = {
  categories: ['name', 'nominal_code', 'active'],
  departments: ['name', 'dept_code', 'active'],
  vehicle_types: ['name', 'active'],
  mileage_rates: ['name', 'vehicle_type', 'rate_pence', 'afr_pence', 'vat_rate_id', 'effective_from', 'active'],
  suppliers: ['name', 'active'],
  vat_rates: ['name', 'percent', 'active'],
};
Object.keys(REF).forEach(table => {
  app.get(`/api/${table}`, auth, (req, res) => res.json(queryAll(`SELECT * FROM ${table}`)));
  app.post(`/api/${table}`, auth, requireRole('finance'), (req, res) => {
    const cols = REF[table], id = uuidv4();
    const vals = cols.map(c => req.body[c] ?? null);
    runSql(`INSERT INTO ${table} (id,${cols.join(',')}) VALUES (${['?', ...cols.map(() => '?')].join(',')})`, [id, ...vals]);
    res.json({ id });
  });
  app.put(`/api/${table}/:id`, auth, requireRole('finance'), (req, res) => {
    const cols = REF[table];
    runSql(`UPDATE ${table} SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`, [...cols.map(c => req.body[c] ?? null), req.params.id]);
    res.json({ ok: true });
  });
});

// Suppliers: any authenticated user may add (so a new supplier becomes available to all)
app.post('/api/suppliers/quick', auth, (req, res) => {
  const id = uuidv4();
  runSql('INSERT INTO suppliers (id,name,created_by) VALUES (?,?,?)', [id, req.body.name, req.user.id]);
  res.json({ id });
});

// ── Users (finance admin) ──
app.get('/api/users', auth, (req, res) => {
  res.json(queryAll('SELECT id,username,full_name,email,roles,department_id,approver1_id,approver2_id,active FROM users'));
});
app.post('/api/users', auth, requireRole('finance'), (req, res) => {
  const id = uuidv4();
  const hash = bcrypt.hashSync(req.body.password || 'changeme', 10);
  const b = req.body;
  runSql('INSERT INTO users (id,username,password_hash,full_name,email,roles,department_id,approver1_id,approver2_id,must_change_password) VALUES (?,?,?,?,?,?,?,?,?,1)',
    [id, b.username.toLowerCase(), hash, b.full_name, b.email || null, (b.roles || []).join(','), b.department_id || null, b.approver1_id || null, b.approver2_id || null]);
  res.json({ id });
});

// ── Reports + lines ──
app.get('/api/reports', auth, (req, res) => {
  let rows;
  if (hasRole(req.user, 'finance')) rows = queryAll('SELECT * FROM reports');
  else rows = queryAll('SELECT * FROM reports WHERE user_id = ?', [req.user.id]);
  rows.forEach(r => r.lines = queryAll('SELECT * FROM lines WHERE report_id = ?', [r.id]));
  res.json(rows);
});
app.post('/api/reports', auth, (req, res) => {
  const id = uuidv4();
  runSql('INSERT INTO reports (id,user_id,type,title,status,notes) VALUES (?,?,?,?,?,?)',
    [id, req.user.id, req.body.type || 'expense', req.body.title, 'unsubmitted', req.body.notes || null]);
  res.json({ id });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => {
  app.listen(PORT, () => console.log(`Komfort Expenses System running on http://localhost:${PORT}`));
}).catch(err => { console.error('Failed to start:', err); process.exit(1); });
