"use strict";
// Diploma kayıt örneği PDF'i: tek A4 sayfada üstte öğrencinin dilekçesi, altta
// okulun resmi yazısı. Yazı tipi olarak sistemdeki Arial (ya da benzeri bir
// TrueType) alt kümelenerek gömülür; böylece Türkçe karakterler doğru basılır.
// Hiç TrueType bulunamazsa Helvetica ile ASCII'ye indirgenmiş metin basılır.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const TEMPLATE_VERSION = "2.0.0";
const A4 = { width: 595.28, height: 841.89 };
const BODY = 10;
const LINE = 12;
const LEFT = 38;
const RIGHT = A4.width - 38;
const CENTER = A4.width / 2;

/* ---------- Yazı tipi dosyaları ---------- */

const FONT_FILES = {
  regular: ["arial.ttf", "Arial.ttf", "LiberationSans-Regular.ttf", "DejaVuSans.ttf"],
  bold: ["arialbd.ttf", "Arialbd.ttf", "Arial Bold.ttf", "LiberationSans-Bold.ttf", "DejaVuSans-Bold.ttf"],
};

function fontDirs() {
  return [
    process.env.DIPLOMA_FONT_DIR,
    path.join(__dirname, "..", "fonts"),
    process.env.WINDIR && path.join(process.env.WINDIR, "Fonts"),
    "C:\\Windows\\Fonts",
    "/usr/share/fonts/truetype/msttcorefonts",
    "/usr/share/fonts/truetype/liberation",
    "/usr/share/fonts/truetype/dejavu",
    "/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
  ].filter(Boolean);
}

function findFontFile(names) {
  for (const dir of fontDirs()) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/* ---------- TrueType okuma ---------- */

function parseTrueType(buffer) {
  const numTables = buffer.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    tables[buffer.toString("latin1", at, at + 4)] = {
      offset: buffer.readUInt32BE(at + 8),
      length: buffer.readUInt32BE(at + 12),
    };
  }
  for (const tag of ["head", "hhea", "hmtx", "maxp", "cmap", "loca", "glyf"]) {
    if (!tables[tag]) throw new Error(`TrueType tablosu eksik: ${tag}`);
  }
  const head = tables.head.offset;
  const unitsPerEm = buffer.readUInt16BE(head + 18);
  const bbox = [36, 38, 40, 42].map((o) => buffer.readInt16BE(head + o));
  const indexToLocFormat = buffer.readInt16BE(head + 50);
  const hhea = tables.hhea.offset;
  const ascent = buffer.readInt16BE(hhea + 4);
  const descent = buffer.readInt16BE(hhea + 6);
  const numberOfHMetrics = buffer.readUInt16BE(hhea + 34);
  const numGlyphs = buffer.readUInt16BE(tables.maxp.offset + 4);
  const advances = new Uint16Array(numGlyphs);
  let last = 0;
  for (let g = 0; g < numGlyphs; g++) {
    if (g < numberOfHMetrics) last = buffer.readUInt16BE(tables.hmtx.offset + g * 4);
    advances[g] = last;
  }
  const loca = new Uint32Array(numGlyphs + 1);
  for (let g = 0; g <= numGlyphs; g++) {
    loca[g] =
      indexToLocFormat === 0
        ? buffer.readUInt16BE(tables.loca.offset + g * 2) * 2
        : buffer.readUInt32BE(tables.loca.offset + g * 4);
  }
  let capHeight = ascent;
  if (tables["OS/2"] && tables["OS/2"].length >= 90) capHeight = buffer.readInt16BE(tables["OS/2"].offset + 88);
  const italicAngle = tables.post ? buffer.readInt32BE(tables.post.offset + 4) / 65536 : 0;
  return {
    buffer,
    tables,
    unitsPerEm,
    bbox,
    ascent,
    descent,
    capHeight,
    italicAngle,
    numGlyphs,
    advances,
    loca,
    cmap: parseCmap(buffer, tables.cmap.offset),
  };
}

// Unicode (BMP) -> glif numarası; format 4 alt tablosu.
function parseCmap(buffer, offset) {
  const map = new Map();
  const count = buffer.readUInt16BE(offset + 2);
  let subtable = null;
  for (let i = 0; i < count; i++) {
    const record = offset + 4 + i * 8;
    const platform = buffer.readUInt16BE(record);
    const encoding = buffer.readUInt16BE(record + 2);
    const at = offset + buffer.readUInt32BE(record + 4);
    if (buffer.readUInt16BE(at) !== 4) continue;
    if ((platform === 3 && encoding === 1) || platform === 0) {
      subtable = at;
      break;
    }
  }
  if (subtable === null) return map;
  const segCountX2 = buffer.readUInt16BE(subtable + 6);
  const ends = subtable + 14;
  const starts = ends + segCountX2 + 2;
  const deltas = starts + segCountX2;
  const ranges = deltas + segCountX2;
  for (let s = 0; s < segCountX2 / 2; s++) {
    const end = buffer.readUInt16BE(ends + s * 2);
    const start = buffer.readUInt16BE(starts + s * 2);
    const delta = buffer.readInt16BE(deltas + s * 2);
    const rangeOffset = buffer.readUInt16BE(ranges + s * 2);
    if (start === 0xffff) continue;
    for (let code = start; code <= end; code++) {
      let glyph;
      if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
      else {
        const at = ranges + s * 2 + rangeOffset + (code - start) * 2;
        if (at + 1 >= buffer.length) continue;
        glyph = buffer.readUInt16BE(at);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(code, glyph);
    }
  }
  return map;
}

// Bileşik glifler (ör. "ğ" = g + breve) parça gliflerine de ihtiyaç duyar.
function collectComponents(font, glyph, into) {
  const start = font.loca[glyph];
  const end = font.loca[glyph + 1];
  if (end <= start) return;
  const at = font.tables.glyf.offset + start;
  if (font.buffer.readInt16BE(at) >= 0) return;
  let p = at + 10;
  for (;;) {
    const flags = font.buffer.readUInt16BE(p);
    const component = font.buffer.readUInt16BE(p + 2);
    p += 4;
    if (!into.has(component)) {
      into.add(component);
      collectComponents(font, component, into);
    }
    p += flags & 0x0001 ? 4 : 2;
    if (flags & 0x0008) p += 2;
    else if (flags & 0x0040) p += 4;
    else if (flags & 0x0080) p += 8;
    if (!(flags & 0x0020)) break;
  }
}

function tableChecksum(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 4) sum = (sum + buffer.readUInt32BE(i)) >>> 0;
  return sum;
}

function pad4(buffer) {
  return buffer.length % 4 ? Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4))]) : buffer;
}

// Yalnızca kullanılan glifleri içeren TrueType dosyası. Glif numaraları
// korunur (loca'da kullanılmayanlar boş), bu yüzden CIDToGIDMap /Identity kalır.
function subsetTrueType(font, usedGlyphs) {
  const used = new Set(usedGlyphs);
  used.add(0);
  for (const glyph of [...used]) collectComponents(font, glyph, used);
  const glyfParts = [];
  const loca = Buffer.alloc((font.numGlyphs + 1) * 4);
  let position = 0;
  for (let g = 0; g < font.numGlyphs; g++) {
    loca.writeUInt32BE(position, g * 4);
    if (!used.has(g) || font.loca[g + 1] <= font.loca[g]) continue;
    const chunk = pad4(font.buffer.subarray(font.tables.glyf.offset + font.loca[g], font.tables.glyf.offset + font.loca[g + 1]));
    glyfParts.push(chunk);
    position += chunk.length;
  }
  loca.writeUInt32BE(position, font.numGlyphs * 4);
  const raw = (tag) => font.buffer.subarray(font.tables[tag].offset, font.tables[tag].offset + font.tables[tag].length);
  const head = Buffer.from(raw("head"));
  head.writeUInt32BE(0, 8);
  head.writeInt16BE(1, 50);
  const entries = [
    ["cvt ", font.tables["cvt "] && raw("cvt ")],
    ["fpgm", font.tables.fpgm && raw("fpgm")],
    ["glyf", Buffer.concat(glyfParts)],
    ["head", head],
    ["hhea", raw("hhea")],
    ["hmtx", raw("hmtx")],
    ["loca", loca],
    ["maxp", raw("maxp")],
    ["prep", font.tables.prep && raw("prep")],
  ].filter(([, data]) => data);
  const count = entries.length;
  const entrySelector = Math.floor(Math.log2(count));
  const searchRange = 2 ** entrySelector * 16;
  const header = Buffer.alloc(12 + count * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(count, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(count * 16 - searchRange, 10);
  const bodies = [];
  let offset = header.length;
  let headOffset = 0;
  entries.forEach(([tag, data], i) => {
    const padded = pad4(data);
    const at = 12 + i * 16;
    header.write(tag, at, 4, "latin1");
    header.writeUInt32BE(tableChecksum(padded), at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(data.length, at + 12);
    if (tag === "head") headOffset = offset;
    bodies.push(padded);
    offset += padded.length;
  });
  const file = Buffer.concat([header, ...bodies]);
  file.writeUInt32BE((0xb1b0afba - tableChecksum(file)) >>> 0, headOffset + 8);
  return file;
}

/* ---------- Belge içinde yazı tipi kullanımı ---------- */

class TrueTypeUse {
  constructor(data, name, bold) {
    this.data = data;
    this.name = name;
    this.bold = bold;
    this.used = new Set([0]);
    this.unicode = new Map();
  }
  glyph(ch) {
    return this.data.cmap.get(ch.codePointAt(0)) ?? 0;
  }
  measure(text, size) {
    let width = 0;
    for (const ch of text) width += this.data.advances[this.glyph(ch)];
    return (width * size) / this.data.unitsPerEm;
  }
  encode(text) {
    let hex = "";
    for (const ch of text) {
      const glyph = this.glyph(ch);
      this.used.add(glyph);
      if (glyph && !this.unicode.has(glyph)) this.unicode.set(glyph, ch);
      hex += glyph.toString(16).padStart(4, "0");
    }
    return `<${hex}>`;
  }
  embed(pdf) {
    const { data } = this;
    const scale = 1000 / data.unitsPerEm;
    const round = (v) => Math.round(v * scale);
    const digest = crypto.createHash("md5").update([...this.used].join(",")).digest();
    const tag = [...digest.subarray(0, 6)].map((b) => String.fromCharCode(65 + (b % 26))).join("");
    const baseFont = `${tag}+${this.name}${this.bold ? ",Bold" : ""}`;
    const subset = subsetTrueType(data, this.used);
    const file = pdf.stream(`/Length1 ${subset.length}`, subset);
    const descriptor = pdf.add(
      `<< /Type /FontDescriptor /FontName /${baseFont} /Flags ${this.bold ? 32 | (1 << 18) : 32} /FontBBox [${data.bbox.map(round).join(" ")}] /ItalicAngle ${data.italicAngle} /Ascent ${round(data.ascent)} /Descent ${round(data.descent)} /CapHeight ${round(data.capHeight)} /StemV ${this.bold ? 140 : 80} /FontFile2 ${file} 0 R >>`,
    );
    const widths = [...this.used]
      .sort((a, b) => a - b)
      .map((g) => `${g} [${round(data.advances[g])}]`)
      .join(" ");
    const cid = pdf.add(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>`,
    );
    const toUnicode = pdf.stream("", Buffer.from(toUnicodeCMap(this.unicode), "latin1"));
    return pdf.add(
      `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`,
    );
  }
}

function toUnicodeCMap(unicode) {
  const entries = [...unicode].map(([glyph, ch]) => {
    const code = ch.codePointAt(0);
    return `<${glyph.toString(16).padStart(4, "0")}> <${code.toString(16).padStart(4, "0")}>`;
  });
  const blocks = [];
  for (let i = 0; i < entries.length; i += 100) {
    const slice = entries.slice(i, i + 100);
    blocks.push(`${slice.length} beginbfchar\n${slice.join("\n")}\nendbfchar`);
  }
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...blocks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
}

// Yedek: Helvetica, ASCII'ye indirgenmiş metin (TrueType bulunamazsa).
const HELVETICA = "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584".split(" ").map(Number);
const HELVETICA_BOLD = "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584".split(" ").map(Number);

function ascii(value) {
  return String(value ?? "")
    .replace(/[ğĞ]/g, (c) => (c === "ğ" ? "g" : "G"))
    .replace(/[şŞ]/g, (c) => (c === "ş" ? "s" : "S"))
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?");
}

class StandardUse {
  constructor(bold) {
    this.bold = bold;
    this.widths = bold ? HELVETICA_BOLD : HELVETICA;
  }
  measure(text, size) {
    let width = 0;
    for (const ch of ascii(text)) width += this.widths[ch.charCodeAt(0) - 32] ?? 556;
    return (width * size) / 1000;
  }
  encode(text) {
    return `(${ascii(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
  }
  embed(pdf) {
    return pdf.add(`<< /Type /Font /Subtype /Type1 /BaseFont /${this.bold ? "Helvetica-Bold" : "Helvetica"} /Encoding /WinAnsiEncoding >>`);
  }
}

let fontCache = null;
function loadFontData() {
  if (fontCache) return fontCache;
  const load = (names) => {
    const file = findFontFile(names);
    if (!file) return null;
    try {
      return { data: parseTrueType(fs.readFileSync(file)), name: path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9]/g, "") || "Font" };
    } catch {
      return null;
    }
  };
  const regular = load(FONT_FILES.regular);
  const bold = regular ? load(FONT_FILES.bold) : null;
  fontCache = { regular, bold };
  return fontCache;
}

function documentFonts() {
  const { regular, bold } = loadFontData();
  if (!regular) return { regular: new StandardUse(false), bold: new StandardUse(true), embedded: false };
  return {
    regular: new TrueTypeUse(regular.data, regular.name, false),
    bold: bold ? new TrueTypeUse(bold.data, bold.name, true) : new TrueTypeUse(regular.data, regular.name, true),
    embedded: true,
  };
}

/* ---------- PDF yazıcı ---------- */

class PdfWriter {
  constructor() {
    this.objects = [];
  }
  add(body) {
    this.objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    return this.objects.length;
  }
  reserve() {
    this.objects.push(null);
    return this.objects.length;
  }
  set(number, body) {
    this.objects[number - 1] = Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1");
  }
  stream(dict, data) {
    const deflated = zlib.deflateSync(data);
    return this.add(
      Buffer.concat([
        Buffer.from(`<< ${dict} /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
        deflated,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  }
  build(root, info) {
    const parts = [Buffer.from("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let length = parts[0].length;
    const offsets = [];
    this.objects.forEach((body, i) => {
      offsets.push(length);
      const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
      const tail = Buffer.from("\nendobj\n", "latin1");
      parts.push(head, body, tail);
      length += head.length + body.length + tail.length;
    });
    const xref = length;
    parts.push(
      Buffer.from(
        `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${this.objects.length + 1} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
        "latin1",
      ),
    );
    return Buffer.concat(parts);
  }
}

/* ---------- Sayfa düzeni ---------- */

const n = (value) => (Math.round(value * 100) / 100).toString();

class Page {
  constructor(fonts) {
    this.fonts = fonts;
    this.ops = [];
  }
  font(key) {
    return key === "bold" ? { use: this.fonts.bold, id: "F2" } : { use: this.fonts.regular, id: "F1" };
  }
  // top: sayfanın üst kenarından ölçülen satır taban çizgisi.
  text(x, top, value, { font = "regular", size = BODY, align = "left" } = {}) {
    const text = String(value ?? "");
    if (!text) return 0;
    const { use, id } = this.font(font);
    const width = use.measure(text, size);
    const x0 = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
    this.ops.push(`BT /${id} ${n(size)} Tf ${n(x0)} ${n(A4.height - top)} Td ${use.encode(text)} Tj ET`);
    return width;
  }
  // Metni verilen genişliğe sözcük sözcük böler; tek sözcük sığmazsa olduğu gibi kalır.
  wrap(value, width, { font = "regular", size = BODY } = {}) {
    const { use } = this.font(font);
    const lines = [];
    let current = "";
    for (const word of String(value ?? "").split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && use.measure(candidate, size) > width) {
        lines.push(current);
        current = word;
      } else current = candidate;
    }
    if (current) lines.push(current);
    return lines;
  }
  // İki yana yaslı paragraf; son satır sola yaslı. Satır sayısını döndürür.
  paragraph(x, top, width, value, { size = BODY, lineHeight = LINE, indent = 0 } = {}) {
    const { use, id } = this.font("regular");
    const words = String(value ?? "").split(/\s+/).filter(Boolean);
    const space = use.measure(" ", size);
    const lines = [];
    let current = [];
    let currentWidth = 0;
    let available = width - indent;
    for (const word of words) {
      const w = use.measure(word, size);
      if (current.length && currentWidth + space + w > available) {
        lines.push({ words: current, width: currentWidth, indent: lines.length ? 0 : indent });
        current = [];
        currentWidth = 0;
        available = width;
      }
      currentWidth += (current.length ? space : 0) + w;
      current.push(word);
    }
    if (current.length) lines.push({ words: current, width: currentWidth, indent: lines.length ? 0 : indent });
    lines.forEach((line, index) => {
      const last = index === lines.length - 1;
      const wordsWidth = line.words.reduce((sum, w) => sum + use.measure(w, size), 0);
      const gap = last || line.words.length < 2 ? space : (width - line.indent - wordsWidth) / (line.words.length - 1);
      let cursor = x + line.indent;
      const y = A4.height - (top + index * lineHeight);
      for (const word of line.words) {
        this.ops.push(`BT /${id} ${n(size)} Tf ${n(cursor)} ${n(y)} Td ${use.encode(word)} Tj ET`);
        cursor += use.measure(word, size) + gap;
      }
    });
    return lines.length;
  }
}

/* ---------- Belge içeriği ---------- */

function normalize(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function upperTr(value) {
  return normalize(value).toLocaleUpperCase("tr-TR");
}

function today() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

// "Okulu" -> "Okulundan", "Lisesi" -> "Lisesinden", "Okul" -> "Okuldan".
function ablative(word) {
  const lower = word.toLocaleLowerCase("tr-TR");
  const vowels = lower.match(/[aeıioöuü]/g);
  const back = vowels ? "aıou".includes(vowels[vowels.length - 1]) : true;
  const consonant = /[aeıioöuü]$/.test(lower) ? "nd" : /[çfhkpsşt]$/.test(lower) ? "t" : "d";
  return `${word}${consonant}${back ? "an" : "en"}`;
}

const RELATIONS = ["oğlu/kızı", "oğlu", "kızı"];

// İstemciden gelen dilekçe alanlarını temizler, boş olanları kayıt ve okul
// bilgilerinden doldurur. Sunucu ve PDF üreticisi aynı yapıyı kullanır.
function documentOptions(raw = {}, student = {}, settings = {}) {
  const clean = (value, max = 120) => normalize(value).slice(0, max);
  const lines = String(raw.address ?? student.address ?? "")
    .split(/\r?\n/)
    .map((line) => normalize(line).slice(0, 70))
    .filter(Boolean)
    .slice(0, 4);
  return {
    applicantName: clean(raw.applicantName) || clean(student.full_name),
    graduation: clean(raw.graduation, 20) || clean(student.diploma_date, 20) || (student.graduation_year ? String(student.graduation_year) : ""),
    documentDate: clean(raw.documentDate, 20) || today(),
    addressLines: lines,
    phone: clean(raw.phone ?? student.phone, 30),
    district: clean(raw.district ?? student.district ?? settings.district, 40),
    province: clean(raw.province ?? student.province ?? settings.province, 40),
    relation: RELATIONS.includes(raw.relation) ? raw.relation : RELATIONS[0],
    schoolPhrase: clean(raw.schoolPhrase ?? settings.school_phrase, 160) || (normalize(settings.school_name) ? ablative(normalize(settings.school_name)) : "okulumuzdan"),
  };
}

function petitionLines(options) {
  const suffix = /^\d{4}$/.test(options.graduation) ? "yılında" : "tarihinde";
  const when = options.graduation ? `${options.graduation} ${suffix} okulunuzdan` : "Okulunuzdan";
  return [`${when} mezun oldum. Diplomamı kaybettim.`, "Diploma kayıt örneğinin tarafıma verilmesini arz ederim."];
}

function recordSentence(student, options) {
  const parts = ["Dilekçe sahibi"];
  const identity = normalize(student.identity_number);
  if (identity) parts.push(`${identity} T.C. Kimlik nolu`);
  const birth = [normalize(student.birth_date), normalize(student.birth_place)].filter(Boolean).join(" ");
  if (birth) parts.push(`${birth} doğumlu`);
  const father = normalize(student.father_name);
  if (father) parts.push(`${father} ${options.relation}`);
  parts.push(normalize(student.full_name));
  parts.push(options.schoolPhrase);
  const degree = normalize(student.degree);
  if (degree) parts.push(`${degree} diploma derecesi ile`);
  parts.push("mezun olarak");
  const diploma = [];
  if (normalize(student.diploma_date)) diploma.push(`${normalize(student.diploma_date)} tarih`);
  if (normalize(student.diploma_number)) diploma.push(`${normalize(student.diploma_number)} nolu`);
  if (diploma.length) parts.push(diploma.join(" ve "));
  parts.push("diplomayı almaya hak kazandığı kayıtların incelenmesinden anlaşılmıştır.");
  return parts.join(" ");
}

function renderDocument(page, student, settings, options) {
  // Başlık ortalanır; sayfaya sığmazsa okul adı ve "MÜDÜRLÜĞÜNE" iki satıra ayrılır.
  const schoolName = upperTr(settings.school_name) || "OKUL ADI";
  const heading = { font: "bold", size: 11, align: "center" };
  let headingTop = 125;
  let headingWidth = page.fonts.bold.measure(`${schoolName} MÜDÜRLÜĞÜNE`, 11);
  if (headingWidth <= RIGHT - LEFT) page.text(CENTER, headingTop, `${schoolName} MÜDÜRLÜĞÜNE`, heading);
  else {
    headingWidth = Math.min(RIGHT - LEFT, page.text(CENTER, headingTop, schoolName, heading));
    headingTop += 13;
    page.text(CENTER, headingTop, "MÜDÜRLÜĞÜNE", heading);
  }
  const district = upperTr(options.district);
  if (district) page.text(CENTER + headingWidth / 2, headingTop + 13, district, { ...heading, align: "right" });

  const [first, second] = petitionLines(options);
  page.text(84, 185, first);
  page.text(84, 197, second);
  page.text(440, 212, options.documentDate, { align: "right" });

  let top = 250;
  page.text(LEFT, top, "ADRES");
  const applicant = upperTr(options.applicantName);
  page.text(Math.min(418, RIGHT - page.fonts.regular.measure(applicant, BODY)), top, applicant);
  // Adres sayfanın sol yarısını aşmaz; uzun satırlar orta çizgiden önce kırılır.
  const addressWidth = CENTER - LEFT;
  const addressLines = options.addressLines.flatMap((line) => page.wrap(line, addressWidth)).slice(0, 6);
  for (const line of addressLines) {
    top += LINE;
    page.text(LEFT, top, line);
  }
  if (options.phone) {
    top += LINE;
    page.text(LEFT, top, options.phone);
  }
  const place = [district, upperTr(options.province)].filter(Boolean).join(" / ");
  if (place) {
    top += LINE;
    page.text(93, top, place);
  }

  page.text(CENTER, 412, "DİPLOMA KAYIT ÖRNEĞİ", { font: "bold", size: 11, align: "center" });
  page.paragraph(LEFT, 462, RIGHT - LEFT, recordSentence(student, options), { indent: 48 });

  page.text(445, 561, options.documentDate, { align: "right" });
  page.text(410, 602, normalize(settings.principal_name), { align: "center" });
  page.text(410, 614, normalize(settings.principal_title) || "Okul Müdürü", { align: "center" });
}

function buildDiplomaPdf(student, settings = {}, rawOptions = {}) {
  const options = documentOptions(rawOptions, student, settings);
  const fonts = documentFonts();
  const page = new Page(fonts);
  renderDocument(page, student, settings, options);

  const pdf = new PdfWriter();
  const catalog = pdf.reserve();
  const pages = pdf.reserve();
  const pageObject = pdf.reserve();
  const regular = fonts.regular.embed(pdf);
  const bold = fonts.bold.embed(pdf);
  const contents = pdf.stream("", Buffer.from(page.ops.join("\n"), "latin1"));
  pdf.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
  pdf.set(pages, `<< /Type /Pages /Kids [${pageObject} 0 R] /Count 1 >>`);
  pdf.set(
    pageObject,
    `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${n(A4.width)} ${n(A4.height)}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${contents} 0 R >>`,
  );
  const info = pdf.add(`<< /Producer (Diploma Kayit ${TEMPLATE_VERSION}) >>`);
  return { buffer: pdf.build(catalog, info), options, embedded: fonts.embedded };
}

function writeDiplomaPdf(student, settings, outputPath, rawOptions = {}) {
  const { buffer, options, embedded } = buildDiplomaPdf(student, settings, rawOptions);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return Promise.resolve({ outputPath, templateVersion: TEMPLATE_VERSION, options, embedded });
}

module.exports = { writeDiplomaPdf, buildDiplomaPdf, documentOptions, recordSentence, ablative, TEMPLATE_VERSION };
