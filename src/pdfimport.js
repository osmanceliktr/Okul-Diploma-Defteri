// e-Okul "İlköğretim Kurumları Diploma Defteri" PDF'ini kayıtlara ayırır.
// Sayfa başına dört kart; her kartta solda öğrenci etiketleri ("Adı", "Soyadı",
// "Baba Adı" …) ve sağda "DİPLOMANIN" bloğu ("Puanı", "Numarası", "Tarihi").
// Etiketler x konumuna göre, değerler etiketle aynı satır (±4,5 pt) üzerinden eşlenir.
const { extractText } = require("./pdftext");
const { normalize } = require("./db");

const LEFT_LABELS = {
  "Numarası": "student_number",
  "T.C. Kimlik No": "identity_number",
  "Adı": "first_name",
  "Soyadı": "last_name",
  "Sınıfı": "class",
  "Baba Adı": "father_name",
  "Ana Adı": "mother_name",
  "Doğum Yeri": "birth_place",
  "Doğum Tarihi": "birth_date",
  "Yabancı Dili": "language",
};
const RIGHT_LABELS = { "Puanı": "degree", "Numarası": "diploma_number", "Tarihi": "diploma_date" };
const ANCHOR = /^ÖĞRENCİNİN/;
const Y_TOLERANCE = 4.5;
const CARD_HEIGHT = 150;

function normalizeDate(text) {
  const match = normalize(text).match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  return match ? `${match[1].padStart(2, "0")}.${match[2].padStart(2, "0")}.${match[3]}` : normalize(text);
}

function canon(text) {
  return normalize(text).replace(/\s*:\s*$/, "");
}

function headerValue(lines, label) {
  for (const line of lines.slice(0, 6)) {
    const text = line.runs.map((r) => r.text).join(" ");
    const match = text.match(new RegExp(`${label}\\s*:\\s*([^|]+?)(?:\\s{2,}|$)`));
    if (match) return normalize(match[1]);
  }
  return "";
}

function valueNear(runs, y, minX, maxX) {
  return normalize(
    runs
      .filter((r) => r.x >= minX && r.x < maxX && Math.abs(r.y - y) <= Y_TOLERANCE)
      .sort((a, b) => a.x - b.x)
      .map((r) => r.text)
      .join(" "),
  ).replace(/^:\s*/, "");
}

function parseCard(runs, top) {
  const region = runs.filter((r) => r.y <= top + 6 && r.y > top - CARD_HEIGHT);
  const fields = {};
  const labelX = region.filter((r) => ANCHOR.test(r.text)).map((r) => r.x)[0] ?? 35;
  for (const run of region) {
    const text = canon(run.text);
    if (run.x < labelX + 55 && LEFT_LABELS[text]) {
      fields[LEFT_LABELS[text]] = valueNear(region, run.y, labelX + 55, labelX + 175);
    } else if (run.x > labelX + 330 && run.x < labelX + 400 && RIGHT_LABELS[text]) {
      fields[RIGHT_LABELS[text]] = valueNear(region, run.y, labelX + 380, labelX + 540);
    }
  }
  return fields;
}

function parseDiplomaRegister(buffer, { maxPages = Infinity } = {}) {
  const extracted = extractText(buffer, { maxPages });
  const cards = [];
  const warnings = [];
  let school = "";
  let district = "";
  for (const page of extracted.pages) {
    if (!school) school = headerValue(page.lines, "Okulun Adı");
    if (!district) district = headerValue(page.lines, "İli / İlçesi").replace(/\s*Öğretim.*$/, "");
    const term = headerValue(page.lines, "Öğretim Yılı");
    const pageLabel = headerValue(page.lines, "Sayfa") || String(page.index);
    const anchors = page.runs.filter((r) => ANCHOR.test(r.text)).sort((a, b) => b.y - a.y);
    if (!anchors.length) {
      if (page.runs.length) warnings.push(`PDF sayfası ${page.index}: öğrenci kartı bulunamadı.`);
      continue;
    }
    anchors.forEach((anchor, index) => {
      const fields = parseCard(page.runs, anchor.y);
      const fullName = normalize(`${fields.first_name || ""} ${fields.last_name || ""}`);
      if (!fullName) {
        warnings.push(`PDF sayfası ${page.index}, kart ${index + 1}: ad soyad okunamadı.`);
        return;
      }
      const identity = (fields.identity_number || "").replace(/\D/g, "");
      cards.push({
        full_name: fullName,
        identity_number: /^\d{11}$/.test(identity) ? identity : "",
        father_name: fields.father_name || "",
        mother_name: fields.mother_name || "",
        birth_place: fields.birth_place || "",
        birth_date: normalizeDate(fields.birth_date || ""),
        diploma_number: fields.diploma_number || "",
        diploma_date: normalizeDate(fields.diploma_date || ""),
        degree: (fields.degree || "").slice(0, 20),
        source_sheet: `Sayfa ${pageLabel}`,
        source_row: index + 1,
        source_payload: JSON.stringify({ ...fields, term, pdfPage: page.index }),
      });
    });
  }
  return { cards, warnings, school, district, pageCount: extracted.pageCount, pagesRead: extracted.pages.length };
}

module.exports = { parseDiplomaRegister, LEFT_LABELS, RIGHT_LABELS };
