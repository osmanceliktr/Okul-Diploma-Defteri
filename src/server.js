const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { URL } = require("node:url");
const { createDatabase, normalize, nameKey, searchStudents, studentFields, DEFAULT_DISTRICT, DEFAULT_PROVINCE } = require("./db");
const { inspectSource, sourceRows, sourceKind, hash } = require("./importer");
const { runImport, revertImport, previousImport, findDuplicate, duplicateStatements, REASONS } = require("./imports");
const { writeDiplomaPdf, documentOptions, TEMPLATE_VERSION } = require("./pdf");

const ROOT = path.join(__dirname, "..");
// Sürüm package.json'dan okunur; esbuild paketlerken dosyayı bundle'a gömer.
const APP_VERSION = require("../package.json").version;
const MAX_BODY = 25 * 1024 * 1024;
const SESSION_TTL = 12 * 60 * 60 * 1000;
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW = 5 * 60 * 1000;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};
const SETTINGS_FIELDS = [
  "school_name",
  "institution_code",
  "address",
  "principal_name",
  "principal_title",
  "administrator_name",
  "administrator_title",
  "district",
  "province",
  "school_phrase",
];

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const error = new Error("İstek gövdesi 25 MB sınırını aşıyor.");
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new Error("Geçersiz JSON gövdesi."));
      }
    });
    req.on("error", reject);
  });
}

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function studentPayload(body) {
  const out = {};
  for (const field of studentFields) out[field] = normalize(body[field]);
  // Takvim girişinden gelen ISO tarihler arşiv biçimine (GG.AA.YYYY) çevrilir.
  for (const field of ["birth_date", "diploma_date"]) {
    const iso = out[field].match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) out[field] = `${iso[3]}.${iso[2]}.${iso[1]}`;
  }
  if (!out.district) out.district = DEFAULT_DISTRICT;
  if (!out.province) out.province = DEFAULT_PROVINCE;
  if (!out.full_name) throw new Error("Ad soyad zorunludur.");
  if (out.degree.length > 20) throw new Error("Derece en çok 20 karakter olabilir.");
  if (!out.volume_no) throw new Error("Cilt no zorunludur.");
  if (out.identity_number && !/^\d{11}$/.test(out.identity_number))
    throw new Error("T.C. kimlik no 11 haneli olmalıdır.");
  out.name_key = nameKey(out.full_name);
  return out;
}

function createApp(options = {}) {
  const db = createDatabase(options.dbPath);
  const password = options.password || process.env.DIPLOMA_PASSWORD || "12345";
  const publicDir = options.publicDir || path.join(ROOT, "public");
  // Masaüstü paketinde arayüz dosyaları exe içine gömülüdür ve bellekten sunulur.
  const publicFiles = options.publicFiles || null;
  const exportDir = options.exportDir || path.join(ROOT, "data", "exports");
  const sessions = new Map();
  const pendingImports = new Map();
  const loginAttempts = new Map();

  function sessionOf(req) {
    const token = cookies(req).diploma_session;
    const session = token && sessions.get(token);
    if (!session) return null;
    if (Date.now() - session.lastSeen > SESSION_TTL) {
      sessions.delete(token);
      return null;
    }
    session.lastSeen = Date.now();
    return session;
  }

  function throttled(ip) {
    const entry = loginAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.first > LOGIN_WINDOW) {
      loginAttempts.delete(ip);
      return false;
    }
    return entry.count >= LOGIN_LIMIT;
  }

  function recordFailure(ip) {
    const entry = loginAttempts.get(ip);
    if (entry && Date.now() - entry.first <= LOGIN_WINDOW) entry.count++;
    else loginAttempts.set(ip, { first: Date.now(), count: 1 });
  }

  function getStudent(id) {
    return db.prepare("SELECT * FROM students WHERE id=?").get(Number(id));
  }
  function getSettings() {
    return db.prepare("SELECT * FROM school_settings WHERE id=1").get();
  }

  // Dilekçe alanları (adres, telefon vb.) istemciden gelir; boş olanlar kayıt ve
  // okul bilgilerinden tamamlanır ve bir sonraki belge için saklanır.
  async function issue(res, id, body) {
    const student = getStudent(id);
    if (!student) return json(res, 404, { error: "Öğrenci bulunamadı." });
    const settings = getSettings();
    const options = documentOptions(body || {}, student, settings);
    // Dilekçede düzeltilen adres bilgileri kayda da işlenir; liste güncel kalır.
    if (["address", "phone", "district", "province"].some((key) => key in (body || {}))) {
      db.prepare("UPDATE students SET address=?, phone=?, district=?, province=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(
        options.addressLines.join(" "),
        options.phone,
        options.district || DEFAULT_DISTRICT,
        options.province || DEFAULT_PROVINCE,
        student.id,
      );
    }
    const filename = `diploma-${student.id}-${Date.now()}.pdf`;
    await writeDiplomaPdf(student, settings, path.join(exportDir, filename), options);
    const result = db
      .prepare(
        "INSERT INTO issuances (student_id, action, template_version, output_path, details) VALUES (?,?,?,?,?)",
      )
      .run(student.id, "generated", TEMPLATE_VERSION, filename, JSON.stringify(options));
    json(res, 201, {
      issuanceId: Number(result.lastInsertRowid),
      url: `/exports/${filename}`,
      filename,
    });
  }

  function inspectImport(res, body) {
    const kind = body.filename && sourceKind(body.filename);
    if (!kind || !body.data)
      return json(res, 400, { error: "Bir .xls, .xlsx veya .pdf dosyası seçin." });
    const buffer = Buffer.from(String(body.data), "base64");
    if (!buffer.length) return json(res, 400, { error: "Dosya boş." });
    const sheets = inspectSource(buffer, body.filename);
    const id = crypto.randomUUID();
    pendingImports.set(id, { buffer, filename: body.filename, sheets });
    const timer = setTimeout(() => pendingImports.delete(id), 30 * 60 * 1000);
    timer.unref?.();
    json(res, 200, { importId: id, filename: body.filename, sheets });
  }

  function commitImport(res, body) {
    const pending = pendingImports.get(body.importId);
    if (!pending)
      return json(res, 400, { error: "Önizleme süresi doldu. Dosyayı yeniden seçin." });
    const sheet = pending.sheets.find((item) => item.name === body.sheetName);
    if (!sheet || sheet.isTemplate)
      return json(res, 400, { error: "Geçerli bir cilt sayfası seçin." });
    const volumeNo = normalize(body.volumeNo || sheet.suggestedVolume);
    if (!volumeNo || (sheet.suggestedVolume && volumeNo !== sheet.suggestedVolume))
      return json(res, 400, { error: "Cilt numarası sayfa adıyla eşleşmelidir." });
    const mapping = body.mapping && typeof body.mapping === "object" ? body.mapping : sheet.mapping;
    if (mapping.full_name === undefined || mapping.full_name === "")
      return json(res, 400, { error: "Ad soyad sütunu eşlenmelidir." });
    const earlier = previousImport(db, hash(pending.buffer), sheet.name);
    if (earlier && !body.confirmRepeat)
      return json(res, 409, {
        error: `Bu dosyanın "${sheet.name}" sayfası daha önce aktarılmış (${earlier.accepted_rows} kayıt). Yine de aktarılsın mı?`,
        code: "repeat",
        previousImportId: earlier.id,
      });
    const result = runImport(db, {
      rows: sourceRows(pending.buffer, sheet, mapping, volumeNo),
      buffer: pending.buffer,
      filename: pending.filename,
      sheetName: sheet.name,
      volumeNo,
    });
    pendingImports.delete(body.importId);
    json(res, 200, result);
  }

  function stats() {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS students, COUNT(DISTINCT volume_no) AS volumes,
                MIN(CASE WHEN diploma_date GLOB '*[0-9][0-9][0-9][0-9]' THEN CAST(substr(diploma_date, -4) AS INTEGER) END) AS first_year,
                MAX(CASE WHEN diploma_date GLOB '*[0-9][0-9][0-9][0-9]' THEN CAST(substr(diploma_date, -4) AS INTEGER) END) AS last_year
         FROM students`,
      )
      .get();
    const volumes = db
      .prepare(
        `SELECT volume_no, COUNT(*) AS count FROM students
         GROUP BY volume_no ORDER BY CAST(volume_no AS INTEGER), volume_no`,
      )
      .all();
    const issuances = db
      .prepare(
        `SELECT SUM(action='generated') AS generated, SUM(action='printed') AS printed
         FROM issuances`,
      )
      .get();
    const recentIssuances = db
      .prepare(
        `SELECT i.id, i.student_id, i.action, i.created_at, i.output_path, s.full_name, s.volume_no, s.diploma_number
         FROM issuances i JOIN students s ON s.id=i.student_id ORDER BY i.id DESC LIMIT 6`,
      )
      .all();
    const recentImports = db
      .prepare("SELECT * FROM imports ORDER BY id DESC LIMIT 4")
      .all();
    const missingIdentity = db
      .prepare("SELECT COUNT(*) AS count FROM students WHERE identity_number IS NULL OR identity_number=''")
      .get().count;
    // Yönetici istatistikleri: diploma yılına göre dağılım, son 12 ayın belge talebi, eksik alanlar.
    const byYear = db
      .prepare(
        `SELECT CAST(substr(diploma_date, -4) AS INTEGER) AS year, COUNT(*) AS count FROM students
         WHERE diploma_date GLOB '*[0-9][0-9][0-9][0-9]' GROUP BY year ORDER BY year`,
      )
      .all();
    const byMonth = db
      .prepare(
        `SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count FROM issuances
         WHERE action='generated' AND created_at >= date('now', 'start of month', '-11 months')
         GROUP BY month ORDER BY month`,
      )
      .all();
    const period = db
      .prepare(
        `SELECT SUM(action='generated' AND strftime('%Y', created_at)=strftime('%Y', 'now')) AS this_year,
                SUM(action='generated' AND strftime('%Y-%m', created_at)=strftime('%Y-%m', 'now')) AS this_month
         FROM issuances`,
      )
      .get();
    const missing = db
      .prepare(
        `SELECT SUM(identity_number IS NULL OR identity_number='') AS identity,
                SUM(birth_date IS NULL OR birth_date='') AS birth_date,
                SUM(father_name IS NULL OR father_name='') AS father_name,
                SUM(diploma_number IS NULL OR diploma_number='') AS diploma_number,
                SUM(diploma_date IS NULL OR diploma_date='') AS diploma_date,
                SUM(address IS NULL OR address='') AS address
         FROM students`,
      )
      .get();
    return {
      students: totals.students,
      volumes: totals.volumes,
      firstYear: totals.first_year,
      lastYear: totals.last_year,
      generated: issuances.generated || 0,
      printed: issuances.printed || 0,
      missingIdentity,
      byVolume: volumes,
      byYear,
      byMonth,
      thisYear: period.this_year || 0,
      thisMonth: period.this_month || 0,
      missing: Object.fromEntries(Object.entries(missing).map(([key, value]) => [key, value || 0])),
      recentIssuances,
      recentImports,
      settings: getSettings(),
      templateVersion: TEMPLATE_VERSION,
    };
  }

  async function handle(req, res, url, body) {
    const { pathname } = url;
    const ip = req.socket.remoteAddress || "local";

    if (req.method === "POST" && pathname === "/api/login") {
      if (throttled(ip))
        return json(res, 429, { error: "Çok fazla deneme. Beş dakika sonra tekrar deneyin." });
      if (!safeEqual(body.password ?? "", password)) {
        recordFailure(ip);
        return json(res, 401, { error: "Parola hatalı." });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(24).toString("hex");
      sessions.set(token, { created: Date.now(), lastSeen: Date.now() });
      res.writeHead(200, {
        "Set-Cookie": `diploma_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "GET" && pathname === "/api/session")
      return json(res, 200, { authenticated: Boolean(sessionOf(req)), app: "diploma-kayit", desktop: Boolean(options.desktop), version: APP_VERSION, instance: options.instance || null });
    // Masaüstü penceresi açıkken sunucuyu canlı tutar; giriş ekranı da gönderir, oturum gerekmez.
    if (req.method === "POST" && pathname === "/api/heartbeat") {
      if (typeof options.onHeartbeat === "function") options.onHeartbeat();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && pathname === "/api/logout") {
      sessions.delete(cookies(req).diploma_session);
      res.writeHead(200, {
        "Set-Cookie": "diploma_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        "Content-Type": "application/json; charset=utf-8",
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (!sessionOf(req)) return json(res, 401, { error: "Oturum gerekli." });

    if (req.method === "GET" && pathname === "/api/stats") return json(res, 200, stats());
    if (req.method === "GET" && pathname === "/api/settings") return json(res, 200, getSettings());
    if (req.method === "PUT" && pathname === "/api/settings") {
      const values = SETTINGS_FIELDS.map((key) => normalize(body[key]));
      db.prepare(
        `UPDATE school_settings SET ${SETTINGS_FIELDS.map((k) => `${k}=?`).join(", ")}, updated_at=CURRENT_TIMESTAMP WHERE id=1`,
      ).run(...values);
      return json(res, 200, getSettings());
    }
    if (req.method === "GET" && pathname === "/api/students")
      return json(
        res,
        200,
        searchStudents(db, {
          query: url.searchParams.get("q") || "",
          volume: url.searchParams.get("volume") || "",
          limit: Number(url.searchParams.get("limit")) || 100,
          offset: Number(url.searchParams.get("offset")) || 0,
        }),
      );
    if (req.method === "POST" && pathname === "/api/students") {
      const payload = studentPayload(body);
      const duplicate = findDuplicate(db, payload, duplicateStatements(db));
      if (duplicate && !body.confirmDuplicate)
        return json(res, 409, {
          error: `Bu kayıt arşivde zaten var (${REASONS[duplicate.reason] || "mükerrer"}). Yine de eklensin mi?`,
          code: "duplicate",
          existingId: duplicate.id,
        });
      const result = db
        .prepare(
          `INSERT INTO students (${studentFields.join(",")}, name_key)
           VALUES (${studentFields.map((f) => `@${f}`).join(",")}, @name_key)`,
        )
        .run(payload);
      return json(res, 201, getStudent(result.lastInsertRowid));
    }
    const studentMatch = pathname.match(/^\/api\/students\/(\d+)(\/issue|\/issuances)?$/);
    if (studentMatch) {
      const id = Number(studentMatch[1]);
      const sub = studentMatch[2];
      if (!getStudent(id)) return json(res, 404, { error: "Öğrenci bulunamadı." });
      if (sub === "/issue" && req.method === "POST") return issue(res, id, body);
      if (sub === "/issuances" && req.method === "GET")
        return json(
          res,
          200,
          db.prepare("SELECT * FROM issuances WHERE student_id=? ORDER BY id DESC").all(id),
        );
      if (!sub && req.method === "GET") return json(res, 200, getStudent(id));
      if (!sub && req.method === "PUT") {
        // Formda bulunmayan alanlar (ör. ana adı, notlar) silinmez, mevcut değer korunur.
        const payload = { ...studentPayload({ ...getStudent(id), ...body }), id };
        db.prepare(
          `UPDATE students SET ${studentFields.map((f) => `${f}=@${f}`).join(", ")}, name_key=@name_key, updated_at=CURRENT_TIMESTAMP WHERE id=@id`,
        ).run(payload);
        return json(res, 200, getStudent(id));
      }
    }
    if (req.method === "POST" && pathname === "/api/import/inspect") return inspectImport(res, body);
    if (req.method === "POST" && pathname === "/api/import/commit") return commitImport(res, body);
    if (req.method === "GET" && pathname === "/api/imports")
      return json(res, 200, db.prepare("SELECT * FROM imports ORDER BY id DESC LIMIT 100").all());
    const importMatch = pathname.match(/^\/api\/imports\/(\d+)$/);
    if (importMatch && req.method === "DELETE") {
      const force = url.searchParams.get("force") === "1";
      return json(res, 200, revertImport(db, importMatch[1], { force }));
    }
    if (req.method === "GET" && pathname === "/api/issuances")
      return json(
        res,
        200,
        db
          .prepare(
            `SELECT i.*, s.full_name, s.volume_no, s.diploma_number FROM issuances i
             JOIN students s ON s.id=i.student_id ORDER BY i.id DESC LIMIT 200`,
          )
          .all(),
      );
    const printed = pathname.match(/^\/api\/issuances\/(\d+)\/printed$/);
    if (printed && req.method === "POST") {
      const item = db.prepare("SELECT * FROM issuances WHERE id=?").get(Number(printed[1]));
      if (!item) return json(res, 404, { error: "Belge işlemi bulunamadı." });
      db.prepare(
        "INSERT INTO issuances (student_id, action, template_version, output_path) VALUES (?,?,?,?)",
      ).run(item.student_id, "printed", item.template_version, item.output_path);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "Bulunamadı." });
  }

  function serveExport(req, res, pathname) {
    if (!sessionOf(req)) return json(res, 401, { error: "Oturum gerekli." });
    const name = path.basename(pathname);
    if (!/^diploma-\d+-\d+\.pdf$/.test(name)) return json(res, 404, { error: "Bulunamadı." });
    const target = path.join(exportDir, name);
    if (!fs.existsSync(target)) return json(res, 404, { error: "Bulunamadı." });
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(target).pipe(res);
  }

  function serveStatic(res, pathname) {
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    if (publicFiles) {
      const body = /^[\w.-]+$/.test(relative) ? publicFiles.get(relative) : undefined;
      if (!body) return json(res, 404, { error: "Bulunamadı." });
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(relative)] || "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(body);
    }
    const target = path.resolve(publicDir, relative);
    if (!target.startsWith(path.resolve(publicDir) + path.sep) && target !== path.resolve(publicDir, "index.html"))
      return json(res, 404, { error: "Bulunamadı." });
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return json(res, 404, { error: "Bulunamadı." });
    }
    if (!stat.isFile()) return json(res, 404, { error: "Bulunamadı." });
    const ext = path.extname(target);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(target).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/exports/")) return serveExport(req, res, url.pathname);
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD")
          return json(res, 405, { error: "Yöntem desteklenmiyor." });
        return serveStatic(res, url.pathname);
      }
      const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
      await handle(req, res, url, body);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 400, { error: error.message, code: error.code });
    }
  });

  return { server, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3001);
  const { server } = createApp();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Diploma uygulaması http://localhost:${port} adresinde çalışıyor.`);
    if (!process.env.DIPLOMA_PASSWORD)
      console.warn("DIPLOMA_PASSWORD tanımlı değil; geliştirme parolası kullanılıyor.");
  });
}

module.exports = { createApp };
