const { normalize, nameKey, studentFields, DEFAULT_DISTRICT, DEFAULT_PROVINCE } = require("./db");
const { hash } = require("./importer");

const SECONDARY = ["birth_date", "father_name", "mother_name", "diploma_number", "diploma_date"];

// Aynı ciltte aynı ada sahip iki kayıt, ikincil alanlardan hiçbiri çelişmiyorsa mükerrerdir.
// (Bir tarafta boş olan alan çelişki sayılmaz; "Ali Kaya / baba Mehmet" ile
// "Ali Kaya / baba Hasan" ayrı kişilerdir.)
function sameName(candidate, row) {
  return SECONDARY.every((field) => {
    const a = normalize(candidate[field]);
    const b = normalize(row[field]);
    return !a || !b || a === b;
  });
}

function findDuplicate(db, row, statements) {
  if (row.identity_number) {
    const hit = statements.byIdentity.get(row.identity_number);
    if (hit) return { id: hit.id, reason: "kimlik" };
  }
  if (row.diploma_number) {
    const hit = statements.byDiploma.get(row.volume_no, row.diploma_number);
    if (hit) return { id: hit.id, reason: "diploma" };
  }
  const key = nameKey(row.full_name);
  if (key) {
    // İki tarafta da kimlik numarası varsa ve farklıysa bunlar farklı kişilerdir;
    // ad kuralları yalnızca en az bir tarafta kimlik numarası yokken uygulanır.
    const differentPerson = (candidate) =>
      row.identity_number && candidate.identity_number && candidate.identity_number !== row.identity_number;
    for (const candidate of statements.byName.all(row.volume_no, key)) {
      if (!differentPerson(candidate) && sameName(candidate, row)) return { id: candidate.id, reason: "ad" };
    }
    // Kimlik numarası olmayan eski kayıtlar: aynı ad ile aynı diploma tarihi veya
    // aynı diploma numarası, cilt farklı olsa bile aynı kişidir.
    for (const candidate of statements.byNameAny.all(key)) {
      if (differentPerson(candidate)) continue;
      if (row.diploma_date && normalize(candidate.diploma_date) === row.diploma_date) return { id: candidate.id, reason: "ad+tarih" };
      if (row.diploma_number && normalize(candidate.diploma_number) === row.diploma_number) return { id: candidate.id, reason: "ad+diploma" };
    }
  }
  return null;
}

function duplicateStatements(db) {
  return {
    byIdentity: db.prepare("SELECT id FROM students WHERE identity_number=?"),
    byDiploma: db.prepare("SELECT id FROM students WHERE volume_no=? AND diploma_number=? AND diploma_number<>''"),
    byName: db.prepare(`SELECT id, identity_number, ${SECONDARY.join(", ")} FROM students WHERE volume_no=? AND name_key=?`),
    byNameAny: db.prepare("SELECT id, identity_number, diploma_date, diploma_number FROM students WHERE name_key=?"),
  };
}

const REASONS = {
  kimlik: "Aynı kimlik no",
  diploma: "Aynı cilt ve diploma no",
  ad: "Aynı ad, çelişen bilgi yok",
  "ad+tarih": "Aynı ad ve diploma tarihi",
  "ad+diploma": "Aynı ad ve diploma no",
};

function previousImport(db, fileHash, sheetName) {
  return db
    .prepare(
      "SELECT id, created_at, accepted_rows FROM imports WHERE file_hash=? AND status='completed' AND json_extract(details,'$.sheet')=? ORDER BY id DESC LIMIT 1",
    )
    .get(fileHash, sheetName);
}

function runImport(db, { rows, buffer, filename, sheetName, volumeNo }) {
  const columns = [...studentFields, "name_key", "source_sheet", "source_row", "source_payload", "import_id"];
  const insert = db.prepare(
    `INSERT INTO students (${columns.join(",")}) VALUES (${columns.map((c) => `@${c}`).join(",")})`,
  );
  const statements = duplicateStatements(db);
  const duplicates = [];
  let accepted = 0;
  db.exec("BEGIN");
  try {
    const importRow = db
      .prepare(
        "INSERT INTO imports (filename,file_type,file_hash,status,total_rows,accepted_rows,rejected_rows,details) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(filename, "excel", hash(buffer), "running", rows.length, 0, 0, "{}");
    const importId = Number(importRow.lastInsertRowid);
    for (const row of rows) {
      const duplicate = findDuplicate(db, row, statements);
      if (duplicate) {
        duplicates.push({ row: row.source_row, existingId: duplicate.id, reason: duplicate.reason });
        continue;
      }
      const source = {
        ...row,
        district: normalize(row.district) || DEFAULT_DISTRICT,
        province: normalize(row.province) || DEFAULT_PROVINCE,
        name_key: nameKey(row.full_name),
        import_id: importId,
      };
      const record = Object.fromEntries(columns.map((column) => [column, source[column] ?? null]));
      insert.run(record);
      accepted++;
    }
    db.prepare(
      "UPDATE imports SET status='completed', accepted_rows=?, rejected_rows=?, details=? WHERE id=?",
    ).run(accepted, duplicates.length, JSON.stringify({ sheet: sheetName, volumeNo, duplicates }), importId);
    db.exec("COMMIT");
    return { importId, total: rows.length, accepted, rejected: duplicates.length, duplicates, volumeNo };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function revertImport(db, importId, { force = false } = {}) {
  const item = db.prepare("SELECT * FROM imports WHERE id=?").get(Number(importId));
  if (!item) {
    const error = new Error("Aktarım bulunamadı.");
    error.status = 404;
    throw error;
  }
  if (item.status !== "completed") {
    const error = new Error("Bu aktarım zaten geri alınmış.");
    error.status = 409;
    throw error;
  }
  const issued = db
    .prepare("SELECT COUNT(*) AS n FROM issuances WHERE student_id IN (SELECT id FROM students WHERE import_id=?)")
    .get(item.id).n;
  if (issued) {
    const error = new Error(`Bu aktarımdaki kayıtlar için ${issued} belge işlemi var; geri alınamaz.`);
    error.status = 409;
    throw error;
  }
  const edited = db
    .prepare("SELECT COUNT(*) AS n FROM students WHERE import_id=? AND updated_at<>created_at")
    .get(item.id).n;
  if (edited && !force) {
    const error = new Error(`Bu aktarımdaki ${edited} kayıt elle düzenlenmiş. Yine de silmek için onaylayın.`);
    error.status = 409;
    error.code = "edited";
    throw error;
  }
  db.exec("BEGIN");
  try {
    const removed = db.prepare("DELETE FROM students WHERE import_id=?").run(item.id).changes;
    db.prepare(
      "UPDATE imports SET status='reverted', details=json_set(details,'$.revertedAt',datetime('now'),'$.revertedRows',?) WHERE id=?",
    ).run(removed, item.id);
    db.exec("COMMIT");
    return { importId: item.id, removed };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = { runImport, revertImport, previousImport, findDuplicate, duplicateStatements, sameName, REASONS };
