// Küçük bir PDF metin çıkarıcı: nesneleri tarar, FlateDecode akışlarını açar,
// sayfa ağacını yürür ve içerik akışlarındaki metin işleçlerini konumlarıyla
// birlikte döndürür. Harici bağımlılık yoktur; e-Okul/rapor türü metin tabanlı
// PDF'ler hedeflenir, taranmış görüntüler desteklenmez.
const zlib = require("node:zlib");

const WHITESPACE = new Set([0x20, 0x0a, 0x0d, 0x09, 0x0c, 0x00]);
const DELIMS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class Ref {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}
class Name {
  constructor(name) {
    this.name = name;
  }
}

// ---------- Sözdizimi çözümleyici ----------
class Lexer {
  constructor(buffer, pos = 0) {
    this.buf = buffer;
    this.pos = pos;
  }
  skipSpace() {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];
      if (WHITESPACE.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }
  token() {
    this.skipSpace();
    if (this.pos >= this.buf.length) return null;
    const c = this.buf[this.pos];
    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.literalString();
    if (c === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return { kw: "<<" };
      }
      return this.hexString();
    }
    if (c === 0x3e) {
      if (this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { kw: ">>" };
      }
      this.pos++;
      return { kw: ">" };
    }
    if (c === 0x5b) {
      this.pos++;
      return { kw: "[" };
    }
    if (c === 0x5d) {
      this.pos++;
      return { kw: "]" };
    }
    if (c === 0x7b || c === 0x7d) {
      this.pos++;
      return { kw: String.fromCharCode(c) };
    }
    const start = this.pos;
    while (this.pos < this.buf.length && !WHITESPACE.has(this.buf[this.pos]) && !DELIMS.has(this.buf[this.pos])) this.pos++;
    if (this.pos === start) {
      this.pos++;
      return { kw: String.fromCharCode(c) };
    }
    const text = this.buf.toString("latin1", start, this.pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return { num: Number(text) };
    return { kw: text };
  }
  name() {
    this.pos++;
    const start = this.pos;
    while (this.pos < this.buf.length && !WHITESPACE.has(this.buf[this.pos]) && !DELIMS.has(this.buf[this.pos])) this.pos++;
    const raw = this.buf.toString("latin1", start, this.pos);
    return new Name(raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  }
  literalString() {
    this.pos++;
    const out = [];
    let depth = 1;
    while (this.pos < this.buf.length) {
      let c = this.buf[this.pos++];
      if (c === 0x5c) {
        c = this.buf[this.pos++];
        if (c === 0x6e) out.push(0x0a);
        else if (c === 0x72) out.push(0x0d);
        else if (c === 0x74) out.push(0x09);
        else if (c === 0x62) out.push(0x08);
        else if (c === 0x66) out.push(0x0c);
        else if (c >= 0x30 && c <= 0x37) {
          let oct = c - 0x30;
          for (let i = 0; i < 2 && this.buf[this.pos] >= 0x30 && this.buf[this.pos] <= 0x37; i++) oct = oct * 8 + (this.buf[this.pos++] - 0x30);
          out.push(oct & 0xff);
        } else if (c === 0x0d) {
          if (this.buf[this.pos] === 0x0a) this.pos++;
        } else if (c !== 0x0a) out.push(c);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (!depth) break;
        out.push(c);
      } else out.push(c);
    }
    return { str: Buffer.from(out) };
  }
  hexString() {
    this.pos++;
    let hex = "";
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const c = this.buf[this.pos++];
      if (!WHITESPACE.has(c)) hex += String.fromCharCode(c);
    }
    this.pos++;
    if (hex.length % 2) hex += "0";
    return { str: Buffer.from(hex, "hex") };
  }
}

class Parser {
  constructor(buffer, pos = 0) {
    this.lexer = new Lexer(buffer, pos);
  }
  get pos() {
    return this.lexer.pos;
  }
  set pos(value) {
    this.lexer.pos = value;
  }
  // Bir nesne okur; "R" referanslarını ve içerik akışı işleçlerini ayırt eder.
  object(token = this.lexer.token()) {
    if (token === null) return undefined;
    if (token.kw === "<<") {
      const dict = new Map();
      for (;;) {
        const key = this.lexer.token();
        if (!key || key.kw === ">>") break;
        if (!(key instanceof Name)) continue;
        dict.set(key.name, this.object());
      }
      return dict;
    }
    if (token.kw === "[") {
      const array = [];
      for (;;) {
        const next = this.lexer.token();
        if (!next || next.kw === "]") break;
        array.push(this.object(next));
      }
      return array;
    }
    if (token.num !== undefined) {
      const save = this.lexer.pos;
      const t2 = this.lexer.token();
      if (t2 && t2.num !== undefined && Number.isInteger(token.num) && Number.isInteger(t2.num)) {
        const save2 = this.lexer.pos;
        const t3 = this.lexer.token();
        if (t3 && t3.kw === "R") return new Ref(token.num, t2.num);
        this.lexer.pos = save2;
        this.lexer.pos = save;
        return token.num;
      }
      this.lexer.pos = save;
      return token.num;
    }
    if (token.str !== undefined) return token.str;
    if (token instanceof Name) return token;
    if (token.kw === "true") return true;
    if (token.kw === "false") return false;
    if (token.kw === "null") return null;
    return { op: token.kw };
  }
}

// ---------- Belge ----------
class PdfDocument {
  constructor(buffer) {
    this.buf = buffer;
    this.objects = new Map();
    this.cache = new Map();
    this.scanObjects();
  }
  scanObjects() {
    const text = this.buf.toString("latin1");
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let match;
    while ((match = re.exec(text))) {
      // Sonraki tanım öncekini ezer (artımlı güncellemeler).
      this.objects.set(Number(match[1]), match.index + match[0].length);
    }
    if (this.buf.indexOf("/Encrypt") >= 0 && /\/Encrypt\s+\d+\s+\d+\s+R/.test(text.slice(-4096)))
      throw new Error("Şifreli PDF desteklenmiyor.");
  }
  resolve(value) {
    let guard = 0;
    while (value instanceof Ref && guard++ < 32) value = this.fetch(value.num);
    return value;
  }
  fetch(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const pos = this.objects.get(num);
    if (pos === undefined) return null;
    const parser = new Parser(this.buf, pos);
    let value = parser.object();
    if (value instanceof Map) {
      const save = parser.pos;
      const next = parser.lexer.token();
      if (next && next.kw === "stream") {
        let start = parser.pos;
        if (this.buf[start] === 0x0d) start++;
        if (this.buf[start] === 0x0a) start++;
        let length = this.resolve(value.get("Length"));
        if (typeof length !== "number" || length < 0 || start + length > this.buf.length) {
          const end = this.buf.indexOf("endstream", start, "latin1");
          length = end < 0 ? 0 : end - start;
        }
        value = { dict: value, raw: this.buf.subarray(start, start + length) };
      } else parser.pos = save;
    }
    this.cache.set(num, value);
    return value;
  }
  streamData(stream) {
    if (!stream || !stream.raw) return Buffer.alloc(0);
    if (stream.data) return stream.data;
    let data = stream.raw;
    let filters = this.resolve(stream.dict.get("Filter"));
    if (filters instanceof Name) filters = [filters];
    for (const filter of filters || []) {
      const name = this.resolve(filter)?.name;
      if (name === "FlateDecode" || name === "Fl") data = inflate(data);
      else if (name === "ASCIIHexDecode") data = Buffer.from(data.toString("latin1").replace(/>.*$/s, "").replace(/\s+/g, ""), "hex");
      else if (name === "ASCII85Decode") data = ascii85(data);
      else if (name === "DCTDecode" || name === "JPXDecode" || name === "CCITTFaxDecode" || name === "JBIG2Decode") data = Buffer.alloc(0);
      else if (name === "LZWDecode" || name === "RunLengthDecode") throw new Error(`PDF filtresi desteklenmiyor: ${name}`);
    }
    stream.data = data;
    return data;
  }
  catalog() {
    for (let i = this.buf.length - 1; i >= 0; i--) {
      const idx = this.buf.lastIndexOf("trailer", i, "latin1");
      if (idx < 0) break;
      const dict = new Parser(this.buf, idx + 7).object();
      if (dict instanceof Map && dict.get("Root")) return this.resolve(dict.get("Root"));
      i = idx - 1;
    }
    for (const num of this.objects.keys()) {
      const value = this.resolve(new Ref(num, 0));
      if (value instanceof Map && this.resolve(value.get("Type"))?.name === "Catalog") return value;
    }
    return null;
  }
  pages() {
    const out = [];
    const visit = (node, inherited, depth) => {
      node = this.resolve(node);
      if (!(node instanceof Map) || depth > 64) return;
      const props = new Map(inherited);
      for (const key of ["Resources", "MediaBox", "Rotate"]) if (node.has(key)) props.set(key, node.get(key));
      const type = this.resolve(node.get("Type"))?.name;
      const kids = this.resolve(node.get("Kids"));
      if (type === "Pages" || Array.isArray(kids)) for (const kid of kids || []) visit(kid, props, depth + 1);
      else if (type === "Page" || node.has("Contents")) out.push({ node, props });
    };
    const catalog = this.catalog();
    if (catalog) visit(catalog.get("Pages"), new Map(), 0);
    if (!out.length) {
      for (const num of [...this.objects.keys()].sort((a, b) => a - b)) {
        const value = this.resolve(new Ref(num, 0));
        if (value instanceof Map && this.resolve(value.get("Type"))?.name === "Page") visit(value, new Map(), 0);
      }
    }
    return out;
  }
  pageContent(page) {
    let contents = this.resolve(page.node.get("Contents"));
    if (!Array.isArray(contents)) contents = [contents];
    return Buffer.concat(contents.map((c) => Buffer.concat([this.streamData(this.resolve(c)), Buffer.from("\n")])));
  }
}

function inflate(data) {
  try {
    return zlib.inflateSync(data);
  } catch {
    try {
      return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      return Buffer.alloc(0);
    }
  }
}

function ascii85(data) {
  const text = data.toString("latin1").replace(/^<~/, "").replace(/~>.*$/s, "").replace(/\s+/g, "");
  const out = [];
  for (let i = 0; i < text.length; i += 5) {
    let chunk = text.slice(i, i + 5);
    if (chunk === "z") chunk = "!!!!!";
    const pad = 5 - chunk.length;
    chunk += "u".repeat(pad);
    let value = 0;
    for (const ch of chunk) value = value * 85 + (ch.charCodeAt(0) - 33);
    const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    out.push(...bytes.slice(0, 4 - pad));
  }
  return Buffer.from(out);
}

// ---------- Yazı tipleri ----------
const CP1254_HIGH = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ",
  0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9f: "Ÿ",
  0xd0: "Ğ", 0xdd: "İ", 0xde: "Ş", 0xf0: "ğ", 0xfd: "ı", 0xfe: "ş",
};
function cp1254(code) {
  if (code < 0x80) return String.fromCharCode(code);
  if (CP1254_HIGH[code]) return CP1254_HIGH[code];
  return String.fromCharCode(code);
}

// Standart glif adlarından (Differences dizisi) Unicode'a kısa tablo.
const GLYPHS = {
  space: " ", period: ".", comma: ",", colon: ":", semicolon: ";", hyphen: "-", slash: "/", parenleft: "(", parenright: ")", quotesingle: "'", quotedbl: '"',
  Scedilla: "Ş", scedilla: "ş", Gbreve: "Ğ", gbreve: "ğ", Idotaccent: "İ", dotlessi: "ı", Ccedilla: "Ç", ccedilla: "ç", Odieresis: "Ö", odieresis: "ö", Udieresis: "Ü", udieresis: "ü",
  Acircumflex: "Â", acircumflex: "â", Icircumflex: "Î", icircumflex: "î", Ucircumflex: "Û", ucircumflex: "û", endash: "–", emdash: "—", bullet: "•", degree: "°",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ampersand: "&", plus: "+", equal: "=", percent: "%", at: "@", numbersign: "#", asterisk: "*", question: "?", exclam: "!", underscore: "_",
};
function glyphToChar(name) {
  if (GLYPHS[name]) return GLYPHS[name];
  if (name.length === 1) return name;
  const uni = name.match(/^uni([0-9A-Fa-f]{4})/) || name.match(/^u([0-9A-Fa-f]{4,6})$/);
  if (uni) return String.fromCodePoint(parseInt(uni[1], 16));
  const g = name.match(/^g(?:lyph)?(\d+)$/);
  if (g) return "";
  return "";
}

function parseCMap(data) {
  const map = new Map();
  const ranges = [];
  const parser = new Parser(data);
  const stack = [];
  let codeBytes = 0;
  for (;;) {
    const token = parser.lexer.token();
    if (!token) break;
    if (token.kw === "begincodespacerange") {
      for (;;) {
        const lo = parser.lexer.token();
        if (!lo || lo.kw === "endcodespacerange") break;
        const hi = parser.lexer.token();
        if (lo.str) codeBytes = Math.max(codeBytes, lo.str.length);
        if (!hi) break;
      }
      continue;
    }
    if (token.kw === "beginbfchar") {
      for (;;) {
        const src = parser.lexer.token();
        if (!src || src.kw === "endbfchar") break;
        const dst = parser.lexer.token();
        if (src.str && dst) map.set(bytesToInt(src.str), destToString(dst));
      }
      continue;
    }
    if (token.kw === "beginbfrange") {
      for (;;) {
        const lo = parser.lexer.token();
        if (!lo || lo.kw === "endbfrange") break;
        const hi = parser.lexer.token();
        const dst = parser.lexer.token();
        if (!lo.str || !hi || !dst) break;
        const start = bytesToInt(lo.str);
        const end = bytesToInt(hi.str);
        if (dst.kw === "[") {
          let code = start;
          for (;;) {
            const item = parser.lexer.token();
            if (!item || item.kw === "]") break;
            map.set(code++, destToString(item));
          }
        } else if (dst.str) {
          const base = destToString(dst);
          const last = base.codePointAt(base.length - 1) ?? 0;
          const prefix = base.slice(0, base.length - String.fromCodePoint(last).length);
          for (let code = start; code <= end && code - start < 65536; code++) map.set(code, prefix + String.fromCodePoint(last + code - start));
        }
      }
      continue;
    }
    stack.push(token);
  }
  return { map, codeBytes: codeBytes || 1, ranges };
}
function bytesToInt(buffer) {
  let value = 0;
  for (const byte of buffer) value = value * 256 + byte;
  return value;
}
function destToString(token) {
  if (token instanceof Name) return glyphToChar(token.name);
  if (!token.str) return "";
  const bytes = token.str;
  if (bytes.length === 1) return String.fromCharCode(bytes[0]);
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return out.replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, (s) => (s.length === 2 ? s : ""));
}

class Font {
  constructor(doc, dict) {
    this.doc = doc;
    this.dict = dict;
    const subtype = doc.resolve(dict.get("Subtype"))?.name;
    this.type0 = subtype === "Type0";
    this.codeBytes = 1;
    this.toUnicode = null;
    this.differences = new Map();
    this.widths = new Map();
    this.defaultWidth = 500;
    const toUnicode = doc.resolve(dict.get("ToUnicode"));
    if (toUnicode && toUnicode.raw) {
      const cmap = parseCMap(doc.streamData(toUnicode));
      this.toUnicode = cmap.map;
      if (this.type0) this.codeBytes = Math.max(cmap.codeBytes, 2);
    } else if (this.type0) this.codeBytes = 2;
    let descendant = dict;
    if (this.type0) {
      const kids = doc.resolve(dict.get("DescendantFonts"));
      descendant = doc.resolve(Array.isArray(kids) ? kids[0] : kids) || dict;
      const w = doc.resolve(descendant.get("W"));
      this.defaultWidth = doc.resolve(descendant.get("DW")) ?? 1000;
      if (Array.isArray(w)) {
        for (let i = 0; i < w.length; ) {
          const first = doc.resolve(w[i++]);
          const next = doc.resolve(w[i++]);
          if (Array.isArray(next)) next.forEach((width, k) => this.widths.set(first + k, doc.resolve(width)));
          else {
            const width = doc.resolve(w[i++]);
            for (let c = first; c <= next && c - first < 65536; c++) this.widths.set(c, width);
          }
        }
      }
    } else {
      const firstChar = doc.resolve(dict.get("FirstChar")) ?? 0;
      const widths = doc.resolve(dict.get("Widths"));
      if (Array.isArray(widths)) widths.forEach((width, k) => this.widths.set(firstChar + k, doc.resolve(width) || 0));
      const descriptor = doc.resolve(dict.get("FontDescriptor"));
      if (descriptor instanceof Map) this.defaultWidth = doc.resolve(descriptor.get("MissingWidth")) || 500;
      const encoding = doc.resolve(dict.get("Encoding"));
      if (encoding instanceof Map) {
        const diffs = doc.resolve(encoding.get("Differences"));
        if (Array.isArray(diffs)) {
          let code = 0;
          for (const item of diffs) {
            const value = doc.resolve(item);
            if (typeof value === "number") code = value;
            else if (value instanceof Name) this.differences.set(code++, glyphToChar(value.name));
          }
        }
      }
    }
  }
  decode(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i += this.codeBytes) {
      let code = 0;
      for (let k = 0; k < this.codeBytes; k++) code = code * 256 + (bytes[i + k] ?? 0);
      let text;
      if (this.toUnicode && this.toUnicode.has(code)) text = this.toUnicode.get(code);
      else if (this.differences.has(code)) text = this.differences.get(code);
      else if (!this.type0) text = cp1254(code);
      else text = "";
      out.push({ code, text, width: (this.widths.get(code) ?? this.defaultWidth) / 1000 });
    }
    return out;
  }
}

// ---------- İçerik akışı ----------
function multiply(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function extractPageRuns(doc, page) {
  const resources = doc.resolve(page.props.get("Resources")) || new Map();
  const fontDict = doc.resolve(resources.get("Font")) || new Map();
  const fonts = new Map();
  const fontFor = (name) => {
    if (!fonts.has(name)) {
      const dict = doc.resolve(fontDict.get(name));
      fonts.set(name, dict instanceof Map ? new Font(doc, dict) : null);
    }
    return fonts.get(name);
  };
  const content = doc.pageContent(page);
  const parser = new Parser(content);
  const runs = [];
  const operands = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let tm = null;
  let tlm = null;
  let font = null;
  let size = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let hscale = 1;
  let leading = 0;
  let rise = 0;
  let current = null;

  const flush = () => {
    if (current && current.text.trim()) runs.push(current);
    current = null;
  };
  const show = (bytes) => {
    if (!font || !tm) return;
    const glyphs = font.decode(bytes);
    for (const glyph of glyphs) {
      const trm = multiply(multiply([size * hscale, 0, 0, size, 0, rise], tm), ctm);
      const x = trm[4];
      const y = trm[5];
      const scale = Math.hypot(trm[0], trm[1]) || size;
      const isSpace = glyph.text === " ";
      const advance = (glyph.width * size + charSpacing + (isSpace ? wordSpacing : 0)) * hscale;
      if (current) {
        const gap = x - current.end;
        const sameLine = Math.abs(y - current.y) < scale * 0.3;
        if (!sameLine || gap > scale * 0.9 || gap < -scale * 0.5) flush();
        else if (gap > scale * 0.18 && !current.text.endsWith(" ") && !isSpace) current.text += " ";
      }
      if (!current) current = { x, y, end: x, text: "", size: scale, font: font.dict };
      current.text += isSpace ? " " : glyph.text;
      tm = multiply([1, 0, 0, 1, advance, 0], tm);
      current.end = multiply(multiply([1, 0, 0, 1, 0, 0], tm), ctm)[4];
    }
  };

  for (;;) {
    const token = parser.lexer.token();
    if (!token) break;
    const value = parser.object(token);
    if (value && value.op !== undefined) {
      const op = value.op;
      const n = operands.length;
      switch (op) {
        case "q": stack.push(ctm); break;
        case "Q": ctm = stack.pop() || ctm; break;
        case "cm": if (n >= 6) ctm = multiply(operands.slice(n - 6), ctm); break;
        case "BT": tm = [1, 0, 0, 1, 0, 0]; tlm = tm; break;
        case "ET": flush(); tm = null; break;
        case "Tf": font = fontFor(operands[n - 2]?.name); size = operands[n - 1] || 0; break;
        case "Td": tlm = multiply([1, 0, 0, 1, operands[n - 2] || 0, operands[n - 1] || 0], tlm || [1, 0, 0, 1, 0, 0]); tm = tlm; break;
        case "TD": leading = -(operands[n - 1] || 0); tlm = multiply([1, 0, 0, 1, operands[n - 2] || 0, operands[n - 1] || 0], tlm || [1, 0, 0, 1, 0, 0]); tm = tlm; break;
        case "Tm": if (n >= 6) { tlm = operands.slice(n - 6); tm = tlm; } break;
        case "T*": tlm = multiply([1, 0, 0, 1, 0, -leading], tlm || [1, 0, 0, 1, 0, 0]); tm = tlm; break;
        case "TL": leading = operands[n - 1] || 0; break;
        case "Tc": charSpacing = operands[n - 1] || 0; break;
        case "Tw": wordSpacing = operands[n - 1] || 0; break;
        case "Tz": hscale = (operands[n - 1] || 100) / 100; break;
        case "Ts": rise = operands[n - 1] || 0; break;
        case "Tj": if (Buffer.isBuffer(operands[n - 1])) show(operands[n - 1]); break;
        case "'": tlm = multiply([1, 0, 0, 1, 0, -leading], tlm || [1, 0, 0, 1, 0, 0]); tm = tlm; if (Buffer.isBuffer(operands[n - 1])) show(operands[n - 1]); break;
        case '"': wordSpacing = operands[n - 3] || 0; charSpacing = operands[n - 2] || 0; tlm = multiply([1, 0, 0, 1, 0, -leading], tlm || [1, 0, 0, 1, 0, 0]); tm = tlm; if (Buffer.isBuffer(operands[n - 1])) show(operands[n - 1]); break;
        case "TJ": {
          const array = operands[n - 1];
          if (Array.isArray(array)) {
            for (const item of array) {
              if (Buffer.isBuffer(item)) show(item);
              else if (typeof item === "number" && tm) {
                const shift = (-item / 1000) * size * hscale;
                tm = multiply([1, 0, 0, 1, shift, 0], tm);
                if (current && shift > size * 0.18 && !current.text.endsWith(" ")) current.text += " ";
                if (current) current.end = multiply(tm, ctm)[4];
              }
            }
          }
          break;
        }
        case "BI": {
          // Satır içi görüntü: EI'ye kadar atla.
          const idx = content.indexOf("EI", parser.pos, "latin1");
          parser.pos = idx < 0 ? content.length : idx + 2;
          break;
        }
        default: break;
      }
      operands.length = 0;
    } else operands.push(value);
  }
  flush();
  const box = doc.resolve(page.props.get("MediaBox")) || [0, 0, 595, 842];
  return { runs, width: box[2] - box[0], height: box[3] - box[1] };
}

// Çalıştırmaları satırlara toplar (aynı y ≈ aynı satır), x'e göre sıralar.
function linesFromRuns(runs, tolerance = 2.5) {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const run of sorted) {
    const line = lines.find((l) => Math.abs(l.y - run.y) <= tolerance);
    if (line) line.runs.push(run);
    else lines.push({ y: run.y, runs: [run] });
  }
  for (const line of lines) line.runs.sort((a, b) => a.x - b.x);
  return lines;
}

function extractText(buffer, { maxPages = Infinity } = {}) {
  const doc = new PdfDocument(buffer);
  const pages = doc.pages();
  const out = [];
  for (let i = 0; i < Math.min(pages.length, maxPages); i++) {
    const { runs, width, height } = extractPageRuns(doc, pages[i]);
    out.push({ index: i + 1, width, height, runs, lines: linesFromRuns(runs) });
  }
  return { pageCount: pages.length, pages: out };
}

module.exports = { extractText, PdfDocument, extractPageRuns, linesFromRuns, parseCMap };
