const crypto = require("node:crypto");
let XLSX;
try {
  XLSX = require("xlsx");
} catch {
  XLSX = null;
}
const { normalize } = require("./db");
const { parseDiplomaRegister } = require("./pdfimport");

const aliases = {
  full_name: ["ad soyad", "adı soyadı", "adi soyadi", "adı ve soyadı", "öğrenci adı soyadı", "ogrenci adi soyadi"],
  identity_number: ["tc", "tckn", "t.c.", "tc kimlik no", "kimlik no", "kimlik numarası"],
  father_name: ["baba adı", "baba adi"],
  mother_name: ["ana adı", "anne adı", "ana adi", "anne adi"],
  birth_place: ["doğum yeri", "dogum yeri"],
  birth_date: ["doğum tarihi", "dogum tarihi"],
  diploma_number: ["diploma no", "diploma numarası", "diploma numarasi"],
  diploma_date: ["diploma tarihi", "mezuniyet tarihi", "mezuniyet yılı", "mezuniyet yili", "çıkış yılı", "cikis yili", "tarihi"],
  degree: ["derece", "derecesi", "diploma derecesi", "puanı", "puani", "diploma puanı"],
  address: ["adres", "adresi", "ev adresi"],
  phone: ["telefon", "tel", "telefon no", "cep telefonu", "gsm"],
  district: ["ilçe", "ilce", "ilçesi", "ilcesi"],
  province: ["il", "ili", "şehir", "sehir"],
};
const PDF_HEADERS = ["Adı Soyadı", "T.C. Kimlik No", "Baba Adı", "Ana Adı", "Doğum Yeri", "Doğum Tarihi", "Diploma No", "Diploma Tarihi", "Derecesi"];
const PDF_FIELDS = ["full_name", "identity_number", "father_name", "mother_name", "birth_place", "birth_date", "diploma_number", "diploma_date", "degree"];
const HEADER_SCAN = 15;

const MISSING = "Excel içe aktarma için xlsx paketi gerekir. Ağ erişimi olan ortamda `npm install xlsx` çalıştırın.";

function canonical(value) {
  return normalize(value).toLocaleLowerCase("tr-TR").replace(/[.:()]/g, "");
}

// Her başlık için en uzun (en özgül) takma adı seçer: "Diploma Numarası" öğrenci no
// değil diploma no olur. Bir alan yalnızca bir sütuna bağlanır.
function inferMapping(headers) {
  const result = {};
  headers.forEach((header, index) => {
    const text = canonical(header);
    if (!text) return;
    let best = null;
    for (const [field, names] of Object.entries(aliases)) {
      for (const name of names) {
        const alias = canonical(name);
        // Kısa takma adlar ("il", "tel") yalnızca ayrı sözcük olarak eşleşir; "Bilgisi" il değildir.
        const hit = alias.length <= 4 ? new RegExp(`(^|\\s)${alias}(\\s|$)`).test(text) : text.includes(alias);
        if (hit && (!best || alias.length > best.length)) best = { field, length: alias.length };
      }
    }
    if (best && result[best.field] === undefined) result[best.field] = index;
  });
  return result;
}

// Başlık satırı ilk satır olmayabilir (defter adı, boş satırlar, iki satıra bölünmüş
// başlıklar). İlk 15 satır içinde en çok alan eşleyen satır başlık kabul edilir;
// hemen üstündeki satırda metin varsa başlığa eklenir ("Diploma" + "Tarihi").
function detectHeader(rows) {
  let best = { index: 0, score: -1, headers: (rows[0] || []).map(normalize) };
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN); i++) {
    const merged = mergeHeaders(rows[i - 1], rows[i]);
    const score = Object.keys(inferMapping(merged)).length;
    if (score > best.score) best = { index: i, score, headers: merged };
  }
  return best;
}

function mergeHeaders(above, row) {
  return (row || []).map((cell, i) => {
    const text = normalize(cell);
    const prefix = above && typeof above[i] === "string" ? normalize(above[i]) : "";
    return prefix && text ? `${prefix} ${text}` : text;
  });
}

function readWorkbook(buffer) {
  if (!XLSX) throw new Error(MISSING);
  return XLSX.read(buffer, { type: "buffer", cellDates: true, raw: false });
}

// Birleştirilmiş başlık hücreleri ("Diploma" iki sütunun üstünde) yalnızca ilk
// hücrede değer taşır; başlık alanında değer tüm aralığa yayılır.
function sheetRows(workbook, name) {
  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error("Sayfa bulunamadı.");
  // blankrows: boş satırlar da sayılır ki source_row Excel satır numarasıyla aynı olsun.
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: true });
  for (const merge of sheet["!merges"] || []) {
    if (merge.s.r >= HEADER_SCAN) continue;
    const value = rows[merge.s.r]?.[merge.s.c];
    if (value === undefined || value === "") continue;
    for (let r = merge.s.r; r <= Math.min(merge.e.r, HEADER_SCAN - 1); r++) {
      rows[r] = rows[r] || [];
      for (let c = merge.s.c; c <= merge.e.c; c++) if (rows[r][c] === undefined || rows[r][c] === "") rows[r][c] = value;
    }
  }
  return rows;
}

function inspectWorkbook(buffer) {
  const workbook = readWorkbook(buffer);
  return workbook.SheetNames.map((name) => {
    const rows = sheetRows(workbook, name);
    const header = detectHeader(rows);
    const volumeMatch = name.match(/\d+/);
    const key = canonical(name);
    const dataRows = rows.slice(header.index + 1);
    return {
      name,
      headerRow: header.index + 1,
      rowCount: dataRows.filter((row) => row.some((cell) => normalize(cell))).length,
      headers: header.headers,
      mapping: inferMapping(header.headers),
      suggestedVolume: volumeMatch?.[0] || null,
      isTemplate: key.includes("diploma kayıt örneği") || key.includes("diploma kayit ornegi"),
      sampleRows: dataRows.slice(0, 3).map((row) => row.map(cellText)),
    };
  });
}

const JS_DATE_STRING = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT/;

// Excel tarih hücreleri Date nesnesi olarak gelir; arşivde GG.AA.YYYY metni tutulur.
function formatDate(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${date.getFullYear()}`;
}

function cellText(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : formatDate(value);
  const text = normalize(value);
  if (JS_DATE_STRING.test(text)) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return formatDate(parsed);
  }
  return text;
}

function columnIndex(mapping, key) {
  const value = mapping[key];
  if (value === undefined || value === null || value === "") return -1;
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : -1;
}

function parseSheet(buffer, sheetName, mapping, volumeNo) {
  const workbook = readWorkbook(buffer);
  const rows = sheetRows(workbook, sheetName);
  const header = detectHeader(rows);
  const headers = header.headers;
  return rows
    .slice(header.index + 1)
    .map((row, index) => {
      const get = (key) => {
        const column = columnIndex(mapping, key);
        return column < 0 ? "" : cellText(row[column]);
      };
      const payload = Object.fromEntries(
        headers.map((header, i) => [normalize(header) || `kolon_${i + 1}`, cellText(row[i])]),
      );
      return {
        full_name: get("full_name"),
        identity_number: get("identity_number"),
        father_name: get("father_name"),
        mother_name: get("mother_name"),
        birth_place: get("birth_place"),
        birth_date: get("birth_date"),
        diploma_number: get("diploma_number"),
        diploma_date: get("diploma_date"),
        degree: get("degree").slice(0, 20),
        volume_no: String(volumeNo || ""),
        source_sheet: sheetName,
        source_row: header.index + index + 2,
        source_payload: JSON.stringify(payload),
      };
    })
    .filter((student) => student.full_name);
}

// ---------- PDF (e-Okul diploma defteri) ----------
function suggestedVolumeFromName(filename) {
  const range = String(filename).match(/(\d{4})\s*[-–]\s*(\d{4})/);
  return range ? `${range[1]}-${range[2]}` : null;
}

function inspectPdf(buffer, filename) {
  const parsed = parseDiplomaRegister(buffer);
  if (!parsed.cards.length)
    throw new Error("PDF düzeni tanınmadı. Yalnızca e-Okul 'Diploma Defteri' çıktıları (metin tabanlı) desteklenir.");
  return [
    {
      name: "Diploma Defteri",
      kind: "pdf",
      headerRow: null,
      rowCount: parsed.cards.length,
      headers: PDF_HEADERS,
      mapping: Object.fromEntries(PDF_FIELDS.map((field, index) => [field, index])),
      suggestedVolume: suggestedVolumeFromName(filename),
      isTemplate: false,
      sampleRows: parsed.cards.slice(0, 3).map((card) => PDF_FIELDS.map((field) => card[field])),
      school: parsed.school,
      district: parsed.district,
      pageCount: parsed.pageCount,
      warnings: parsed.warnings,
    },
  ];
}

function pdfRows(buffer, volumeNo) {
  return parseDiplomaRegister(buffer).cards.map((card) => ({ ...card, volume_no: String(volumeNo || "") }));
}

function sourceKind(filename) {
  if (/\.pdf$/i.test(filename)) return "pdf";
  if (/\.(xls|xlsx)$/i.test(filename)) return "excel";
  return null;
}

function inspectSource(buffer, filename) {
  return sourceKind(filename) === "pdf" ? inspectPdf(buffer, filename) : inspectWorkbook(buffer);
}

function sourceRows(buffer, sheet, mapping, volumeNo) {
  return sheet.kind === "pdf" ? pdfRows(buffer, volumeNo) : parseSheet(buffer, sheet.name, mapping, volumeNo);
}

function hash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = { inspectWorkbook, inspectPdf, inspectSource, sourceRows, sourceKind, parseSheet, pdfRows, hash, inferMapping, detectHeader, cellText, formatDate, available: Boolean(XLSX) };
