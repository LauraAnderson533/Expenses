const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, 'data', 'expenses-system.db');

let db = null;
let SQL = null;

function saveDb() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}
setInterval(() => { if (db) saveDb(); }, 30000);

async function initDb() {
  if (db) return db;
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  initializeSchema();
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

function initializeSchema() {
  // Users — roles stored as comma list e.g. "employee,manager,finance,credit_card"
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT,
    roles TEXT NOT NULL DEFAULT 'employee',
    department_id TEXT,
    approver1_id TEXT,            -- 1st approver (a manager user)
    approver2_id TEXT,            -- 2nd approver (a finance user)
    active INTEGER DEFAULT 1,
    must_change_password INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, nominal_code TEXT, active INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dept_code TEXT, active INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS vehicle_types (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS mileage_rates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    vehicle_type TEXT,
    rate_pence REAL NOT NULL,      -- payment rate per mile (e.g. HMRC AMAP 45p)
    afr_pence REAL DEFAULT 0,      -- advisory fuel rate per mile, used for VAT reclaim
    vat_rate_id TEXT,
    effective_from TEXT,
    active INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER DEFAULT 1,
    created_by TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS vat_rates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, percent REAL NOT NULL, active INTEGER DEFAULT 1
  )`);

  // Reports — type expense|creditcard
  db.run(`CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL DEFAULT 'expense' CHECK(type IN ('expense','creditcard')),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unsubmitted',
    submitted_at TEXT,
    manager_approved_by TEXT, manager_approved_at TEXT,
    finance_approved_by TEXT, finance_approved_at TEXT,
    reimbursed_at TEXT,
    payment_run_id TEXT,
    rejected_by TEXT, rejected_at TEXT, rejection_note TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Lines — line_type expense|mileage
  db.run(`CREATE TABLE IF NOT EXISTS lines (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES reports(id),
    line_type TEXT NOT NULL CHECK(line_type IN ('expense','mileage')),
    line_date TEXT,
    description TEXT,
    -- expense fields
    supplier_id TEXT,
    category_id TEXT,
    amount REAL DEFAULT 0,          -- gross amount
    vat_rate_id TEXT,
    vat_amount REAL DEFAULT 0,
    -- mileage fields
    postcode_from TEXT,
    postcode_to TEXT,
    distance_miles REAL DEFAULT 0,
    vehicle_type TEXT,
    vehicle_reg TEXT,
    mileage_rate_id TEXT,
    receipts TEXT,                  -- JSON array of {name,mime,data}
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_runs (
    id TEXT PRIMARY KEY,
    reference TEXT,
    run_date TEXT,
    created_by TEXT,
    total REAL DEFAULT 0,
    status TEXT DEFAULT 'completed',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')), user TEXT, action TEXT NOT NULL, details TEXT
  )`);

  db.run('CREATE INDEX IF NOT EXISTS idx_lines_report ON lines(report_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status)');

  db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('company_name','Komfort Partitioning Ltd')");

  // Seed default finance admin + reference data if empty
  const count = db.exec("SELECT COUNT(*) FROM users")[0]?.values[0]?.[0] || 0;
  if (count === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run('INSERT INTO users (id,username,password_hash,full_name,email,roles) VALUES (?,?,?,?,?,?)',
      [uuidv4(), 'finance', hash, 'Finance Administrator', 'finance@komfort.com', 'employee,manager,finance,credit_card']);
    console.log('Default finance admin created — username: finance, password: admin123');

    const vatStd = uuidv4(), vatRed = uuidv4(), vatZero = uuidv4(), vatNone = uuidv4();
    [[vatStd,'Standard 20%',20],[vatRed,'Reduced 5%',5],[vatZero,'Zero 0%',0],[vatNone,'No VAT',0]]
      .forEach(([id,name,p]) => db.run('INSERT INTO vat_rates (id,name,percent) VALUES (?,?,?)',[id,name,p]));

    [['Travel','7400'],['Subsistence','7406'],['Accommodation','7402'],['Fuel','7300'],
     ['Office Supplies','7500'],['Entertaining','8200'],['Mileage','7404'],['Sundry','7906']]
      .forEach(([n,code]) => db.run('INSERT INTO categories (id,name,nominal_code) VALUES (?,?,?)',[uuidv4(),n,code]));

    [['Operations','OPS'],['Manufacturing','MFG'],['Sales','SAL'],['Finance','FIN'],
     ['Installation','INS'],['Design','DSN'],['Management','MGT']]
      .forEach(([n,code]) => db.run('INSERT INTO departments (id,name,dept_code) VALUES (?,?,?)',[uuidv4(),n,code]));

    ['Car - Petrol','Car - Diesel','Car - Electric','Van','Motorcycle']
      .forEach(n => db.run('INSERT INTO vehicle_types (id,name) VALUES (?,?)',[uuidv4(),n]));

    // HMRC AMAP + indicative advisory fuel rates (pence/mile)
    [['HMRC Car (first 10k miles)','Car - Petrol',45,13,vatStd],
     ['HMRC Car (first 10k miles)','Car - Diesel',45,12,vatStd],
     ['HMRC Car EV (first 10k miles)','Car - Electric',45,8,vatStd],
     ['HMRC Car (over 10k miles)','Car - Petrol',25,13,vatStd],
     ['HMRC Motorcycle','Motorcycle',24,0,vatStd]]
      .forEach(([n,vt,r,afr,vid]) => db.run('INSERT INTO mileage_rates (id,name,vehicle_type,rate_pence,afr_pence,vat_rate_id,effective_from) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(),n,vt,r,afr,vid,'2024-09-01']));

    ['Shell','BP','Esso','Premier Inn','Travelodge','Greggs','Costa Coffee','Screwfix','Toolstation']
      .forEach(n => db.run('INSERT INTO suppliers (id,name) VALUES (?,?)',[uuidv4(),n]));
  }

  saveDb();
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function queryGet(sql, params = []) { return queryAll(sql, params)[0] || null; }
function runSql(sql, params = []) { db.run(sql, params); saveDb(); }

module.exports = { initDb, getDb, queryAll, queryGet, runSql, saveDb };
