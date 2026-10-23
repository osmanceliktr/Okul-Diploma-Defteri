const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const studentFields = [
  "full_name",
  "identity_number",
  "father_name",
  "mother_name",
  "birth_place",
  "birth_date",
  "diploma_number",
  "diploma_date",
  "degree",
  "volume_no",
  "notes",
  "address",
  "phone",
  "district",
  "province",
];
// Yeni kayıtlarda ve boş bırakılan alanlarda kullanılan ilçe / il.
const DEFAULT_DISTRICT = "YAKUTİYE";
const DEFAULT_PROVINCE = "ERZURUM";

function createDatabase(filename = path.join(__dirname, "..", "data", "diploma.db")) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS school_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), school_name TEXT NOT NULL DEFAULT '',
      institution_code TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
      principal_name TEXT NOT NULL DEFAULT '', principal_title TEXT NOT NULL DEFAULT 'Okul Müdürü',
      administrator_name TEXT NOT NULL DEFAULT '', administrator_title TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, identity_number TEXT,
      student_number TEXT, father_name TEXT, mother_name TEXT, birth_place TEXT,
      birth_date TEXT, enrollment_year INTEGER, graduation_year INTEGER, diploma_number TEXT,
      diploma_date TEXT, volume_no TEXT NOT NULL, record_no TEXT, page_no TEXT,
      source_sheet TEXT, source_row INTEGER, notes TEXT, source_payload TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_students_name ON students(full_name);
    CREATE INDEX IF NOT EXISTS idx_students_identity ON students(identity_number);
    CREATE INDEX IF NOT EXISTS idx_students_volume_record ON students(volume_no, record_no);
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, file_type TEXT NOT NULL,
      file_hash TEXT, status TEXT NOT NULL, total_rows INTEGER NOT NULL DEFAULT 0,
      accepted_rows INTEGER NOT NULL DEFAULT 0, rejected_rows INTEGER NOT NULL DEFAULT 0,
      details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS issuances (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, action TEXT NOT NULL,
      operator TEXT NOT NULL DEFAULT 'ortak hesap', template_version TEXT NOT NULL,
      output_path TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(student_id) REFERENCES students(id)
    );
    CREATE INDEX IF NOT EXISTS idx_issuances_student ON issuances(student_id);
  `);
  db.prepare("INSERT OR IGNORE INTO school_settings (id) VALUES (1)").run();
  ensureColumn(db, "students", "import_id", "INTEGER");
  ensureColumn(db, "students", "name_key", "TEXT");
  ensureColumn(db, "students", "degree", "TEXT");
  ensureColumn(db, "students", "address", "TEXT");
  ensureColumn(db, "students", "phone", "TEXT");
  ensureColumn(db, "students", "district", `TEXT NOT NULL DEFAULT '${DEFAULT_DISTRICT}'`);
  ensureColumn(db, "students", "province", `TEXT NOT NULL DEFAULT '${DEFAULT_PROVINCE}'`);
  ensureColumn(db, "school_settings", "district", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "school_settings", "province", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "school_settings", "school_phrase", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "issuances", "details", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_students_diploma ON students(volume_no, diploma_number);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_students_name_key ON students(volume_no, name_key);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_students_import ON students(import_id);");
  repairDates(db);
  backfillNameKeys(db);
  backfillImportIds(db);
  return db;
}

function ensureColumn(db, table, column, type) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Ad karşılaştırma anahtarı: Türkçe küçük harf, aksansız, tek boşluk.
function nameKey(value) {
  return normalize(value)
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function backfillNameKeys(db) {
  const rows = db.prepare("SELECT id, full_name FROM students WHERE name_key IS NULL").all();
  if (!rows.length) return;
  const update = db.prepare("UPDATE students SET name_key=? WHERE id=?");
  db.exec("BEGIN");
  try {
    for (const row of rows) update.run(nameKey(row.full_name), row.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// import_id sütunundan önce yapılan aktarımlar: aynı sayfa adı ve aktarım anına
// yakın (2 dk) oluşturulma zamanı ile eşlenir.
function backfillImportIds(db) {
  const orphans = db.prepare("SELECT COUNT(*) AS n FROM students WHERE import_id IS NULL AND source_sheet IS NOT NULL").get().n;
  if (!orphans) return;
  const imports = db
    .prepare("SELECT id, created_at, json_extract(details,'$.sheet') AS sheet FROM imports WHERE status='completed' AND accepted_rows>0 ORDER BY id")
    .all();
  const update = db.prepare(
    "UPDATE students SET import_id=? WHERE import_id IS NULL AND source_sheet=? AND created_at BETWEEN datetime(?, '-120 seconds') AND ?",
  );
  db.exec("BEGIN");
  try {
    for (const item of imports) if (item.sheet) update.run(item.id, item.sheet, item.created_at, item.created_at);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Eski aktarımlar tarihleri "Fri Jun 05 1992 00:00:00 GMT+0300 (...)" biçiminde
// yazmıştı; bir kerelik GG.AA.YYYY biçimine çevrilir.
const DATE_COLUMNS = ["birth_date", "diploma_date"];
function repairDates(db) {
  for (const column of DATE_COLUMNS) {
    const rows = db
      .prepare(`SELECT id, ${column} AS value FROM students WHERE ${column} LIKE '% GMT%'`)
      .all();
    if (!rows.length) continue;
    const update = db.prepare(`UPDATE students SET ${column}=? WHERE id=?`);
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const parsed = new Date(row.value);
        if (Number.isNaN(parsed.getTime())) continue;
        const dd = String(parsed.getDate()).padStart(2, "0");
        const mm = String(parsed.getMonth() + 1).padStart(2, "0");
        update.run(`${dd}.${mm}.${parsed.getFullYear()}`, row.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function normalize(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

// LIKE wildcards in user input would otherwise match everything.
function likePattern(value) {
  return `%${normalize(value).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function searchStudents(db, options = {}) {
  const opts = typeof options === "string" ? { query: options } : options;
  const query = normalize(opts.query);
  const volume = normalize(opts.volume);
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const where = [];
  const params = [];
  if (query) {
    const q = likePattern(query);
    const k = `%${nameKey(query).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      "(full_name LIKE ? ESCAPE '\\' OR name_key LIKE ? ESCAPE '\\' OR identity_number LIKE ? ESCAPE '\\' OR diploma_number LIKE ? ESCAPE '\\' OR father_name LIKE ? ESCAPE '\\')",
    );
    params.push(q, k, q, q, q);
  }
  if (volume) {
    where.push("volume_no = ?");
    params.push(volume);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS count FROM students ${clause}`).get(...params).count;
  const items = db
    .prepare(
      `SELECT id, full_name, identity_number, volume_no, diploma_number, diploma_date, degree
       FROM students ${clause} ORDER BY CAST(volume_no AS INTEGER), volume_no, CAST(diploma_number AS INTEGER), name_key LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return { items, total, limit, offset };
}

module.exports = { createDatabase, normalize, nameKey, searchStudents, studentFields, DEFAULT_DISTRICT, DEFAULT_PROVINCE };
