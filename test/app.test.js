const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDatabase, searchStudents } = require("../src/db");
const { writeDiplomaPdf, buildDiplomaPdf, documentOptions, recordSentence, ablative } = require("../src/pdf");
const { createApp } = require("../src/server");
const importer = require("../src/importer");

test("SQLite öğrenci kaydı ve araması çalışır", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diploma-"));
  const db = createDatabase(path.join(dir, "test.db"));
  db.prepare("INSERT INTO students (full_name, volume_no, diploma_number) VALUES (?,?,?)").run("Ayşe Yılmaz", "3", "15");
  db.prepare("INSERT INTO students (full_name, volume_no, diploma_number) VALUES (?,?,?)").run("Mehmet Kaya", "4", "2");
  const result = searchStudents(db, "Ayşe");
  assert.equal(result.total, 1);
  assert.equal(result.items[0].volume_no, "3");
  assert.equal(searchStudents(db, { volume: "4" }).total, 1);
  const page = searchStudents(db, { limit: 1, offset: 1 });
  assert.equal(page.total, 2, "toplam sayfadan bağımsızdır");
  assert.deepEqual([page.items.length, page.items[0].volume_no, page.offset], [1, "4", 1], "ikinci sayfa ikinci kaydı verir");
  assert.equal(searchStudents(db, "%").total, 0, "LIKE joker karakteri kaçışlanır");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("diploma PDF çıktısı oluşturulur ve işlem için okunabilir", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diploma-pdf-"));
  const output = path.join(dir, "diploma.pdf");
  const result = await writeDiplomaPdf({ full_name: "Test Öğrenci", volume_no: "1", diploma_number: "2", degree: "Pekiyi" }, { school_name: "Deneme Okulu", principal_name: "Müdür" }, output);
  const text = fs.readFileSync(output, "latin1");
  assert.equal(text.slice(0, 7), "%PDF-1.");
  assert.match(text, /\/MediaBox \[0 0 595\.28 841\.89\]/, "A4 sayfa");
  assert.ok(text.endsWith("%%EOF\n"));
  if (result.embedded) {
    assert.equal((text.match(/\/Subtype \/Type0/g) || []).length, 2, "normal ve kalın yazı tipi gömülür");
    assert.ok(text.includes("/FontFile2"), "TrueType alt kümesi gömülür");
    assert.ok(text.includes("/ToUnicode"), "metin kopyalanabilir");
  } else {
    assert.ok(text.includes("/Helvetica"), "yazı tipi bulunamazsa Helvetica");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("belge seçenekleri temizlenir ve kayıt cümlesi kurulur", () => {
  const student = { full_name: "Test Öğrenci", identity_number: "10000000000", birth_date: "01.01.1960", birth_place: "Erzurum", father_name: "Baba", diploma_number: "15", diploma_date: "30.06.1975", degree: "İyi", graduation_year: 1975 };
  const settings = { school_name: "Deneme İlkokulu", district: "Yakutiye", province: "Erzurum", school_phrase: "" };
  const options = documentOptions({ address: "  Bir Mah.  \r\n\nİki Sk.\nÜç\nDört\nBeş", phone: " 555 ", relation: "yok", district: "" }, student, settings);
  assert.deepEqual(options.addressLines, ["Bir Mah.", "İki Sk.", "Üç", "Dört"], "en çok dört satır, boşlar atılır");
  assert.equal(options.phone, "555");
  assert.equal(options.relation, "oğlu/kızı", "bilinmeyen yakınlık ön tanımlıya döner");
  assert.equal(options.district, "", "boş gönderilen ilçe boş kalır");
  assert.equal(options.province, "Erzurum", "gönderilmeyen il okul bilgisinden gelir");
  assert.equal(options.graduation, "30.06.1975", "mezuniyet için diploma tarihi kullanılır");
  assert.equal(options.schoolPhrase, "Deneme İlkokulundan", "okul ifadesi okul adından türetilir");
  assert.equal(options.applicantName, "Test Öğrenci");
  assert.match(options.documentDate, /^\d{2}\.\d{2}\.\d{4}$/);
  assert.equal(
    recordSentence(student, options),
    "Dilekçe sahibi 10000000000 T.C. Kimlik nolu 01.01.1960 Erzurum doğumlu Baba oğlu/kızı Test Öğrenci Deneme İlkokulundan İyi diploma derecesi ile mezun olarak 30.06.1975 tarih ve 15 nolu diplomayı almaya hak kazandığı kayıtların incelenmesinden anlaşılmıştır.",
  );
  const sparse = documentOptions({}, { full_name: "Ad Soyad" }, {});
  assert.equal(recordSentence({ full_name: "Ad Soyad" }, sparse), "Dilekçe sahibi Ad Soyad okulumuzdan mezun olarak diplomayı almaya hak kazandığı kayıtların incelenmesinden anlaşılmıştır.");
  assert.equal(ablative("Deneme Lisesi"), "Deneme Lisesinden");
  assert.equal(ablative("Deneme Okul"), "Deneme Okuldan");
  assert.equal(ablative("Deneme Mektep"), "Deneme Mektepten");
  const { buffer } = buildDiplomaPdf(student, settings, options);
  assert.equal(buffer.subarray(0, 5).toString("latin1"), "%PDF-");
});

test("HTTP API: oturum, kayıt, arama, istatistik ve belge akışı", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diploma-http-"));
  const { server, db } = createApp({
    dbPath: path.join(dir, "test.db"),
    exportDir: path.join(dir, "exports"),
    password: "gizli-parola",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let cookie = "";
  const call = (route, options = {}) =>
    fetch(base + route, {
      ...options,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

  assert.equal((await call("/api/stats")).status, 401, "oturumsuz API erişimi reddedilir");
  const anon = await (await call("/api/session")).json();
  assert.deepEqual(anon, { authenticated: false, app: "diploma-kayit", desktop: false, version: require("../package.json").version, instance: null }, "oturum yanıtı uygulama işareti ve sürümü taşır");
  assert.equal((await call("/api/heartbeat", { method: "POST", body: {} })).status, 200, "yaşam sinyali oturum gerektirmez");
  assert.equal((await call("/exports/diploma-1-1.pdf")).status, 401, "oturumsuz PDF erişimi reddedilir");
  assert.equal((await call("/api/login", { method: "POST", body: { password: "yanlış" } })).status, 401);

  const login = await call("/api/login", { method: "POST", body: { password: "gizli-parola" } });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await (await call("/api/session")).json()).authenticated, true);

  const invalid = await call("/api/students", { method: "POST", body: { full_name: "", volume_no: "1" } });
  assert.equal(invalid.status, 400);
  const badIdentity = await call("/api/students", { method: "POST", body: { full_name: "Deneme Mezun", volume_no: "1", identity_number: "123" } });
  assert.equal(badIdentity.status, 400);

  const created = await call("/api/students", {
    method: "POST",
    body: { full_name: "  Deneme   Mezun ", volume_no: "2", diploma_number: "7", diploma_date: "08.06.1990", identity_number: "12345678901", degree: "Pekiyi" },
  });
  assert.equal(created.status, 201);
  const student = await created.json();
  assert.equal(student.full_name, "Deneme Mezun", "boşluklar normalize edilir");
  assert.equal(student.diploma_date, "08.06.1990");
  assert.equal(student.degree, "Pekiyi");
  const repeat = await call("/api/students", { method: "POST", body: { full_name: "Deneme Mezun", volume_no: "9", diploma_date: "08.06.1990" } });
  assert.equal(repeat.status, 409, "aynı ad ve diploma tarihi elle girişte de yakalanır");
  assert.equal((await repeat.json()).code, "duplicate");
  const tooLong = await call("/api/students", { method: "POST", body: { full_name: "Başka Mezun", volume_no: "9", degree: "x".repeat(21) } });
  assert.equal(tooLong.status, 400);

  const updated = await call(`/api/students/${student.id}`, { method: "PUT", body: { ...student, father_name: "Deneme Baba" } });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).father_name, "Deneme Baba");
  assert.equal((await call("/api/students/9999", { method: "PUT", body: student })).status, 404);

  const list = await (await call("/api/students?q=deneme&volume=2")).json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, student.id);

  await call("/api/settings", { method: "PUT", body: { school_name: "Deneme Lisesi", principal_name: "Deneme Müdür", district: "Yakutiye", province: "Erzurum" } });

  const dated = await (await call(`/api/students/${student.id}`, { method: "PUT", body: { ...student, father_name: "Deneme Baba", birth_date: "1960-01-05", diploma_date: "1990-06-08" } })).json();
  assert.equal(dated.birth_date, "05.01.1960", "ISO doğum tarihi GG.AA.YYYY olarak saklanır");
  assert.equal(dated.diploma_date, "08.06.1990", "ISO diploma tarihi GG.AA.YYYY olarak saklanır");
  assert.equal(dated.district, "YAKUTİYE", "ilçe varsayılanı");
  assert.equal(dated.province, "ERZURUM", "il varsayılanı");
  const partial = await (await call(`/api/students/${student.id}`, { method: "PUT", body: { full_name: student.full_name, volume_no: student.volume_no, address: "Örnek Mah. No 1", phone: "0555" } })).json();
  assert.equal(partial.father_name, "Deneme Baba", "gönderilmeyen alanlar korunur");
  assert.equal(partial.address, "Örnek Mah. No 1");
  assert.equal(partial.phone, "0555");
  const issued = await call(`/api/students/${student.id}/issue`, { method: "POST", body: { address: "Test Mah.\nNo 1", phone: "555", relation: "kızı" } });
  assert.equal(issued.status, 201);
  const issue = await issued.json();
  const logs = await (await call(`/api/students/${student.id}/issuances`)).json();
  const details = JSON.parse(logs[0].details);
  assert.deepEqual(details.addressLines, ["Test Mah.", "No 1"], "dilekçe bilgileri işlemle birlikte saklanır");
  assert.equal((await (await call(`/api/students/${student.id}`)).json()).address, "Test Mah. No 1", "dilekçedeki adres kayda işlenir");
  assert.equal(details.relation, "kızı");
  const pdf = await call(issue.url);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal((await call(`/api/issuances/${issue.issuanceId}/printed`, { method: "POST" })).status, 200);
  assert.equal((await call("/exports/../package.json")).status, 404, "dışa aktarma dizini dışına çıkılamaz");

  const stats = await (await call("/api/stats")).json();
  assert.equal(stats.students, 1);
  assert.equal(stats.volumes, 1);
  assert.equal(stats.firstYear, 1990, "yıl aralığı diploma tarihinden türetilir");
  assert.equal(stats.generated, 1);
  assert.equal(stats.printed, 1);
  assert.equal(stats.byVolume[0].volume_no, "2");
  assert.deepEqual(stats.byYear, [{ year: 1990, count: 1 }], "yıla göre dağılım");
  assert.equal(stats.thisYear, 1, "bu yıl düzenlenen belge");
  assert.equal(stats.missing.birth_date, 0);
  assert.equal(stats.missing.father_name, 0);
  assert.equal(stats.byMonth.length, 1);
  assert.equal(stats.settings.school_name, "Deneme Lisesi");

  const history = await (await call("/api/issuances")).json();
  assert.equal(history.length, 2);
  assert.equal(history[0].full_name, "Deneme Mezun");

  assert.equal((await call("/api/logout", { method: "POST" })).status, 200);
  assert.equal((await call("/api/stats")).status, 401, "çıkış sonrası oturum geçersizdir");

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal((await fetch(`${base}/icons.svg`)).headers.get("content-type"), "image/svg+xml");
  assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
});

test("Excel tarih hücreleri GG.AA.YYYY olarak aktarılır ve eski kayıtlar onarılır", { skip: !importer.available && "xlsx paketi yok" }, () => {
  assert.equal(importer.cellText(new Date(1992, 5, 5)), "05.06.1992");
  assert.equal(importer.cellText("Fri Jun 05 1992 00:00:00 GMT+0300 (Türkiye Yaz Saati)"), "05.06.1992");
  assert.equal(importer.cellText("8.6.1974"), "8.6.1974", "metin tarihler olduğu gibi kalır");

  const XLSX = require("xlsx");
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["ADI SOYADI", "DOĞUM TARİHİ", "SIRA NO"], ["Deneme Mezun", new Date(1974, 5, 8), 1]]);
  XLSX.utils.book_append_sheet(workbook, sheet, "CİLT 9");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const [info] = importer.inspectWorkbook(buffer);
  assert.equal(info.sampleRows[0][1], "08.06.1974", "önizleme de biçimli tarih gösterir");
  const [row] = importer.parseSheet(buffer, "CİLT 9", info.mapping, "9");
  assert.equal(row.birth_date, "08.06.1974");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diploma-dates-"));
  const dbPath = path.join(dir, "test.db");
  let db = createDatabase(dbPath);
  db.prepare("INSERT INTO students (full_name, volume_no, birth_date) VALUES (?,?,?)").run("Deneme Mezun", "1", "Fri Jun 05 1992 00:00:00 GMT+0300 (Türkiye Yaz Saati)");
  db.close();
  db = createDatabase(dbPath);
  assert.equal(db.prepare("SELECT birth_date FROM students").get().birth_date, "05.06.1992");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Excel başlık satırı algılanır, iki satırlı başlıklar birleşir ve mükerrerler yakalanır", { skip: !importer.available && "xlsx paketi yok" }, () => {
  const XLSX = require("xlsx");
  const { runImport, revertImport } = require("../src/imports");
  const workbook = XLSX.utils.book_new();
  const rows = [
    ["DİPLOMA DEFTERİ", "", "", ""],
    ["", "", "", ""],
    ["", "", "Diploma ", ""],
    ["Sıra No ", "Adı Soyadı", "Numarası", "Tarihi"],
    [1, "Deneme Bir", 101, new Date(1974, 5, 8)],
    [2, "Deneme İki", 102, new Date(1974, 5, 8)],
    [3, "DENEME  BİR", 103, new Date(1975, 0, 1)],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!merges"] = [{ s: { r: 2, c: 2 }, e: { r: 2, c: 3 } }];
  XLSX.utils.book_append_sheet(workbook, sheet, "7.CİLT");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const [info] = importer.inspectWorkbook(buffer);
  assert.equal(info.headerRow, 4);
  assert.equal(info.rowCount, 3);
  assert.deepEqual(info.headers, ["Sıra No", "Adı Soyadı", "Diploma Numarası", "Diploma Tarihi"]);
  assert.deepEqual(info.mapping, { full_name: 1, diploma_number: 2, diploma_date: 3 });
  assert.equal(info.sampleRows[0][3], "08.06.1974");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diploma-import-"));
  const db = createDatabase(path.join(dir, "test.db"));
  const rowsFor = (mapping) => importer.parseSheet(buffer, "7.CİLT", mapping, "7");
  const first = runImport(db, { rows: rowsFor(info.mapping), buffer, filename: "defter.xlsx", sheetName: "7.CİLT", volumeNo: "7" });
  assert.equal(first.accepted, 3, "farklı diploma no ve tarih taşıyan aynı ad mükerrer sayılmaz");
  assert.equal(db.prepare("SELECT diploma_date FROM students WHERE diploma_number='101'").get().diploma_date, "08.06.1974");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM students WHERE import_id=?").get(first.importId).n, 3);

  const second = runImport(db, { rows: rowsFor(info.mapping), buffer, filename: "defter.xlsx", sheetName: "7.CİLT", volumeNo: "7" });
  assert.equal(second.accepted, 0, "aynı sayfa ikinci kez aktarılınca hepsi mükerrer");
  assert.equal(second.rejected, 3);
  assert.equal(second.duplicates[0].reason, "diploma");

  // Diploma no olmadan yalnızca ada göre: aynı ad + boş ikincil alanlar mükerrerdir.
  const nameOnly = runImport(db, { rows: rowsFor({ full_name: 1 }), buffer, filename: "defter.xlsx", sheetName: "7.CİLT", volumeNo: "7" });
  assert.equal(nameOnly.accepted, 0);
  assert.ok(nameOnly.duplicates.every((d) => d.reason === "ad"));

  // Başka cilde aynı ad + aynı diploma tarihi: kimlik no olmasa da aynı kişi.
  const otherVolume = runImport(db, { rows: rowsFor({ full_name: 1, diploma_date: 3 }).map((r) => ({ ...r, volume_no: "8" })), buffer, filename: "defter.xlsx", sheetName: "7.CİLT", volumeNo: "8" });
  assert.equal(otherVolume.accepted, 0);
  assert.ok(otherVolume.duplicates.every((d) => d.reason === "ad+tarih"));

  const reverted = revertImport(db, first.importId);
  assert.equal(reverted.removed, 3);
  assert.equal(db.prepare("SELECT status FROM imports WHERE id=?").get(first.importId).status, "reverted");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM students").get().n, 0);
  assert.throws(() => revertImport(db, first.importId), /zaten geri alınmış/);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Basit yazı tipli, cp1254 kodlu sentetik bir "Diploma Defteri" PDF'i üretir.
function syntheticRegisterPdf(cards) {
  const esc = (text) => Buffer.from(text, "latin1").toString("latin1").replace(/[\\()]/g, (c) => `\\${c}`);
  const cp1254 = (text) => text.replace(/Ğ/g, "\xd0").replace(/İ/g, "\xdd").replace(/Ş/g, "\xde").replace(/ğ/g, "\xf0").replace(/ı/g, "\xfd").replace(/ş/g, "\xfe");
  const T = (x, y, text) => `BT /F1 6.6 Tf ${x} ${y} Td (${esc(cp1254(text))}) Tj ET`;
  const pages = [];
  for (let p = 0; p < cards.length; p += 4) {
    const ops = [T(206, 759, "İLKÖĞRETİM KURUMLARI DİPLOMA DEFTERİ"), T(534, 759, `Sayfa: ${pages.length + 1}`), T(38, 743, "İli / İlçesi: ERZURUM / YAKUTİYE"), T(431, 743, "Öğretim Yılı: 2007-2008"), T(38, 731, "Okulun Adı: DENEME İLKOKULU")];
    cards.slice(p, p + 4).forEach((card, i) => {
      const top = 700 - i * 160.5;
      ops.push(T(37, top, "ÖĞRENCİNİN"), T(380, top + 10, "DİPLOMANIN"));
      const left = [["Numarası", card.no], ["T.C. Kimlik No", card.tc], ["Adı", card.first], ["Soyadı", card.last], ["Sınıfı", "8. Sınıf/A"], ["Baba Adı", card.father], ["Ana Adı", card.mother], ["Doğum Yeri", card.place], ["Doğum Tarihi", card.birth], ["Yabancı Dili", "İngilizce"]];
      left.forEach(([label, value], k) => { const y = top - 24 - k * 12; ops.push(T(35, y, label), T(97, y + (k % 3 === 2 ? 3 : 0), `: ${value}`)); });
      [["Puanı", card.score], ["Numarası", card.diploma], ["Tarihi", card.date]].forEach(([label, value], k) => { const y = top - 7 - k * 12; ops.push(T(380, y, label), T(424, y, ":"), T(433, y, value)); });
    });
    pages.push(ops.join("\n"));
  }
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  pages.forEach((content) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  });
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

test("e-Okul diploma defteri PDF'i kartlara ayrılır ve arşive aktarılır", () => {
  const cards = [
    { no: "1001", tc: "10000000001", first: "AYŞE", last: "ÇİĞDEM", father: "MEHMET", mother: "FATMA", place: "ERZURUM", birth: "01/02/1994", score: "85,33", diploma: "12", date: "13/06/2008" },
    { no: "1002", tc: "10000000002", first: "ŞÜKRÜ", last: "IŞIK", father: "ALİ", mother: "GÜL", place: "ERZURUM", birth: "11/09/1994", score: "72,10", diploma: "13", date: "13/06/2008" },
    { no: "1003", tc: "10000000003", first: "DENEME", last: "MEZUN", father: "VELİ", mother: "AYŞE", place: "ANKARA", birth: "05/05/1995", score: "91,00", diploma: "14", date: "12/06/2009" },
    { no: "1004", tc: "10000000004", first: "BEŞİR", last: "DAĞ", father: "HASAN", mother: "ELİF", place: "KARS", birth: "20/12/1995", score: "66,50", diploma: "15", date: "12/06/2009" },
    { no: "1005", tc: "10000000005", first: "İLKER", last: "GÖK", father: "OSMAN", mother: "ZEHRA", place: "ERZURUM", birth: "30/01/1996", score: "80,00", diploma: "16", date: "11/06/2010" },
    // Aynı ad ve aynı diploma tarihi ama farklı kimlik no: ayrı kişi.
    { no: "1006", tc: "10000000006", first: "AYŞE", last: "ÇİĞDEM", father: "KEMAL", mother: "NUR", place: "KARS", birth: "02/03/1994", score: "77,00", diploma: "17", date: "13/06/2008" },
  ];
  const buffer = syntheticRegisterPdf(cards);
  const [sheet] = importer.inspectSource(buffer, "2007-2011 DİPLOMA.pdf");
  assert.equal(sheet.kind, "pdf");
  assert.equal(sheet.rowCount, 6);
  assert.equal(sheet.pageCount, 2);
  assert.equal(sheet.school, "DENEME İLKOKULU");
  assert.equal(sheet.suggestedVolume, "2007-2011");
  assert.deepEqual(sheet.sampleRows[0], ["AYŞE ÇİĞDEM", "10000000001", "MEHMET", "FATMA", "ERZURUM", "01.02.1994", "12", "13.06.2008", "85,33"]);
  const rows = importer.sourceRows(buffer, sheet, sheet.mapping, "2007-2011");
  assert.equal(rows[1].full_name, "ŞÜKRÜ IŞIK", "Türkçe harfler korunur");
  assert.equal(rows[4].source_sheet, "Sayfa 2");
  assert.equal(rows[5].source_row, 2);
  assert.equal(rows[4].degree, "80,00");

  const { runImport } = require("../src/imports");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diploma-pdf-import-"));
  const db = createDatabase(path.join(dir, "test.db"));
  const result = runImport(db, { rows, buffer, filename: "2007-2011 DİPLOMA.pdf", sheetName: sheet.name, volumeNo: "2007-2011" });
  assert.equal(result.accepted, 6, "farklı kimlik numaralı adaşlar ayrı kayıttır");
  const again = runImport(db, { rows, buffer, filename: "2007-2011 DİPLOMA.pdf", sheetName: sheet.name, volumeNo: "2007-2011" });
  assert.equal(again.accepted, 0);
  assert.ok(again.duplicates.every((d) => d.reason === "kimlik"));
  const search = searchStudents(db, "cigdem");
  assert.equal(search.total, 2, "aksansız arama Türkçe adı bulur");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
