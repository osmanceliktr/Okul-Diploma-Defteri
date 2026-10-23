"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  view: null,
  stats: null,
  students: { items: [], total: 0 },
  query: "",
  volume: "",
  page: 1,
  pageSize: readPageSize(),
  selectedId: null,
  importJob: null,
  historyTab: "issuances",
};

const STUDENT_FIELDS = [
  ["full_name", "Adı soyadı", { required: true, wide: true }],
  ["identity_number", "T.C. kimlik no", { inputmode: "numeric" }],
  ["volume_no", "Cilt no", { required: true }],
  ["father_name", "Baba adı"],
  ["birth_place", "Doğum yeri"],
  ["birth_date", "Doğum tarihi", { date: true }],
  ["diploma_number", "Diploma no"],
  ["diploma_date", "Diploma tarihi", { date: true }],
  ["degree", "Derecesi", { maxlength: 20, wide: true }],
  ["address", "Adres", { wide: true, maxlength: 200 }],
  ["phone", "Telefon", { inputmode: "tel", maxlength: 30 }],
  ["district", "İlçe", { maxlength: 40 }],
  ["province", "İl", { maxlength: 40 }],
];
// Yeni kayıt formunda hazır gelen değerler.
const NEW_STUDENT_DEFAULTS = { district: "YAKUTİYE", province: "ERZURUM" };

const IMPORT_FIELDS = [
  ["full_name", "Adı soyadı (zorunlu)"],
  ["identity_number", "T.C. kimlik no"],
  ["father_name", "Baba adı"],
  ["mother_name", "Ana adı"],
  ["birth_place", "Doğum yeri"],
  ["birth_date", "Doğum tarihi"],
  ["diploma_number", "Diploma no"],
  ["diploma_date", "Diploma tarihi"],
  ["degree", "Derecesi"],
  ["address", "Adres"],
  ["phone", "Telefon"],
  ["district", "İlçe"],
  ["province", "İl"],
];
const DUPLICATE_REASONS = { kimlik: "Aynı kimlik no", diploma: "Aynı cilt ve diploma no", ad: "Aynı ad, çelişen bilgi yok", "ad+tarih": "Aynı ad ve diploma tarihi", "ad+diploma": "Aynı ad ve diploma no" };

/* ---------- helpers ---------- */

const PAGE_SIZES = [25, 50, 100];
function readPageSize() {
  try {
    const saved = Number(localStorage.getItem("diploma-page-size"));
    if (PAGE_SIZES.includes(saved)) return saved;
  } catch {}
  return 50;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function icon(name) {
  return `<svg class="ic" aria-hidden="true"><use href="/icons.svg?v=1.2.0#i-${name}"/></svg>`;
}
function num(value) {
  return Number(value || 0).toLocaleString("tr-TR");
}
function dash(value) {
  const text = String(value ?? "").trim();
  return text ? esc(text) : '<span class="dash">–</span>';
}
function when(iso) {
  if (!iso) return "";
  const date = new Date(String(iso).replace(" ", "T") + (String(iso).endsWith("Z") ? "" : "Z"));
  if (Number.isNaN(date.getTime())) return esc(iso);
  return date.toLocaleString("tr-TR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function toast(message, type = "neutral", action) {
  const el = document.createElement("div");
  el.className = `toast is-${type}`;
  const iconName = type === "good" ? "circle-check" : type === "bad" ? "circle-x" : "info";
  el.innerHTML = `${icon(iconName)}<span>${esc(message)}</span>`;
  if (action) {
    const button = document.createElement("button");
    button.className = "btn";
    button.type = "button";
    button.textContent = action.label;
    button.onclick = () => { action.run(); el.remove(); };
    el.append(button);
  }
  $("#toasts").append(el);
  setTimeout(() => el.remove(), action ? 12000 : 4500);
}

async function api(url, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showGate();
    throw new Error(body.error || "Oturum gerekli.");
  }
  if (!response.ok) {
    const error = new Error(body.error || "İşlem başarısız.");
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

/* ---------- theme ---------- */

function applyThemeLabel() {
  const current = document.documentElement.dataset.theme;
  const dark = current === "dark" || (!current && matchMedia("(prefers-color-scheme: dark)").matches);
  $("#themeLabel").textContent = dark ? "Açık tema" : "Koyu tema";
  $("#themeIcon").setAttribute("href", `/icons.svg?v=1.2.0#i-${dark ? "sun" : "moon"}`);
}
$("#themeBtn").onclick = () => {
  const current = document.documentElement.dataset.theme;
  const dark = current === "dark" || (!current && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("diploma-theme", next); } catch {}
  applyThemeLabel();
  renderStatsCharts();
};

/* ---------- auth ---------- */

function showGate() {
  $("#gate").hidden = false;
  $("#shell").hidden = true;
  setTimeout(() => $("#password").focus(), 0);
}
function hideGate() {
  $("#gate").hidden = true;
  $("#shell").hidden = false;
}
$("#loginForm").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("button", event.target);
  button.disabled = true;
  $("#loginError").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { password: $("#password").value } });
    $("#password").value = "";
    hideGate();
    await boot();
  } catch (error) {
    $("#loginError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$("#logoutBtn").onclick = async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  state.stats = null;
  showGate();
};

/* ---------- router ---------- */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "") || "students";
  const [view, query = ""] = raw.split("?");
  return { view, params: new URLSearchParams(query) };
}
function navigate(view, params = {}) {
  const query = new URLSearchParams(params).toString();
  location.hash = `/${view}${query ? `?${query}` : ""}`;
}
async function route() {
  const { view, params } = parseHash();
  const known = ["students", "stats", "import", "history", "settings", "guide"];
  const target = known.includes(view) ? view : view === "overview" ? "stats" : "students";
  if (state.view && state.view !== target) $("#toasts").replaceChildren();
  state.view = target;
  for (const section of $$(".view")) section.hidden = section.id !== `view-${target}`;
  for (const link of $$(".nav a")) {
    if (link.dataset.view === target) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  try {
    if (target === "stats") await renderStats();
    if (target === "students") await renderStudents(params);
    if (target === "import") renderImport();
    if (target === "history") await renderHistory();
    if (target === "settings") await renderSettings();
  } catch (error) {
    toast(error.message, "bad");
  }
}
window.addEventListener("hashchange", route);

/* ---------- stats ---------- */

async function loadStats() {
  state.stats = await api("/api/stats");
  setSchoolName(state.stats.settings?.school_name);
  return state.stats;
}

// Kenar çubuğundaki marka satırı ve hesap kutusu ayarlardaki kurum adını gösterir.
function setSchoolName(name) {
  const school = (name || "").trim();
  $("#brandSchool").textContent = school || "Okul arşivi";
  $("#accountSchool").textContent = school || "Kurum adı girilmedi";
}

const MONTHS_TR = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

async function renderStats() {
  const s = await loadStats();
  const years = s.firstYear && s.lastYear ? (s.firstYear === s.lastYear ? `${s.firstYear}` : `${s.firstYear}–${s.lastYear}`) : null;
  const busiest = s.byVolume.reduce((best, v) => (!best || v.count > best.count ? v : best), null);
  $("#statsSubline").textContent = s.students
    ? `${num(s.students)} mezun kaydı ${num(s.volumes)} ciltte${years ? `, ${years} yılları arasında düzenlenmiş diplomalar` : ""}. Bugüne kadar ${num(s.generated)} diploma kayıt örneği düzenlendi.`
    : "Arşiv henüz boş. İlk cildi Excel aktarımı ile yükleyin ya da elle kayıt girin.";

  $("#kpis").innerHTML = [
    ["Kayıtlı mezun", num(s.students), years ? `${years} diplomaları` : "Henüz kayıt yok"],
    ["Cilt defteri", num(s.volumes), busiest ? `En kalabalık cilt ${busiest.volume_no}, ${num(busiest.count)} kayıt` : "Henüz cilt yok"],
    ["Bu yıl düzenlenen belge", num(s.thisYear), `Toplam ${num(s.generated)} belge, ${num(s.printed)} yazdırma`],
    ["Bu ay düzenlenen belge", num(s.thisMonth), s.recentIssuances[0] ? `Son işlem ${when(s.recentIssuances[0].created_at)}` : "Henüz belge düzenlenmedi"],
  ].map(([label, value, note]) => `
    <div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div><div class="kpi-note">${esc(note)}</div></div>`).join("");

  renderYears(s.byYear);
  renderShelf(s.byVolume);
  renderMonths(s.byMonth);
  $("#shelfMeta").textContent = s.byVolume.length ? `${num(s.volumes)} cilt` : "";

  const missingRows = [
    ["Kimlik no", s.missing.identity],
    ["Doğum tarihi", s.missing.birth_date],
    ["Baba adı", s.missing.father_name],
    ["Diploma no", s.missing.diploma_number],
    ["Diploma tarihi", s.missing.diploma_date],
    ["Adres", s.missing.address],
  ];
  $("#missingList").innerHTML = s.students
    ? `<ul class="meter-list">${missingRows.map(([label, count]) => {
        const pct = Math.round((count / s.students) * 100);
        return `<li><span class="meter-label">${esc(label)}</span><span class="meter-track" aria-hidden="true"><span class="meter-fill" style="width:${pct}%"></span></span><span class="meter-value">${num(count)} kayıt <span class="muted">· %${pct}</span></span></li>`;
      }).join("")}</ul>`
    : `<div class="empty"><strong>Henüz kayıt yok</strong>Kayıtlar aktarıldığında eksik alanlar burada sayılır.</div>`;

  $("#recentIssuances").innerHTML = s.recentIssuances.length
    ? `<ul class="list">${s.recentIssuances.map((i) => `
        <li><div class="grow"><div class="name"><a href="#/students?id=${i.student_id}">${esc(i.full_name)}</a></div>
        <div class="meta">${i.action === "printed" ? "Yazdırıldı" : "Belge düzenlendi"} · Cilt ${esc(i.volume_no)}${i.diploma_number ? `, diploma no ${esc(i.diploma_number)}` : ""}</div></div>
        <span class="when">${when(i.created_at)}</span></li>`).join("")}</ul>`
    : `<div class="empty"><strong>Henüz belge düzenlenmedi</strong>Mezunlar ekranında bir kaydı seçip "Belge düzenle" ile ilk kayıt örneğini oluşturun.</div>`;
}

function safeJson(text) {
  try { return JSON.parse(text || "{}") || {}; } catch { return {}; }
}

function niceCeil(value) {
  if (value <= 10) return 10;
  const power = 10 ** Math.floor(Math.log10(value));
  const unit = value / power;
  const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return step * power;
}

// Ortak çubuk grafiği: rows = [{ key, label, value }].
// opts: height, maxBar, tip(row), onClick(row), showLabel(row, i), emptyText, ariaLabel.
function renderBars(host, rows, opts) {
  if (!rows.length || !rows.some((r) => r.value > 0)) {
    host.innerHTML = `<div class="chart-empty">${esc(opts.emptyText)}</div>`;
    return;
  }
  const W = Math.max(320, host.clientWidth - 24);
  const H = opts.height || 300;
  const pad = { l: 40, r: 8, t: 24, b: 28 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const max = Math.max(...rows.map((r) => r.value));
  const top = niceCeil(max);
  const slot = innerW / rows.length;
  const bw = Math.min(opts.maxBar || 24, Math.max(3, slot * 0.62));
  const y = (v) => pad.t + innerH - (v / top) * innerH;
  const maxIndex = rows.findIndex((r) => r.value === max);
  const ticks = [0, top / 2, top];

  const grid = ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="axis-text" x="${pad.l - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${num(t)}</text>`).join("");

  const bars = rows.map((r, i) => {
    const cx = pad.l + slot * i + slot / 2;
    const x = cx - bw / 2;
    const h = Math.max(0, innerH * (r.value / top));
    const yTop = pad.t + innerH - h;
    const radius = Math.min(3, h / 2, bw / 2);
    const path = h > 0
      ? `M${x.toFixed(1)},${(pad.t + innerH).toFixed(1)} v${(-(h - radius)).toFixed(1)} a${radius},${radius} 0 0 1 ${radius},-${radius} h${(bw - 2 * radius).toFixed(1)} a${radius},${radius} 0 0 1 ${radius},${radius} v${(h - radius).toFixed(1)} z`
      : "";
    const band = h > 24 && bw >= 12 ? `<rect class="bar-band" x="${(x + 2).toFixed(1)}" y="${(yTop + 7).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="2"/>` : "";
    const label = i === maxIndex ? `<text class="value-text" x="${cx.toFixed(1)}" y="${(yTop - 6).toFixed(1)}">${num(r.value)}</text>` : "";
    const tick = opts.showLabel(r, i) ? `<text class="axis-text" x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(r.label)}</text>` : "";
    const gap = h === 0 ? `<line class="gap" x1="${x.toFixed(1)}" x2="${(x + bw).toFixed(1)}" y1="${(pad.t + innerH).toFixed(1)}" y2="${(pad.t + innerH).toFixed(1)}"/>` : "";
    return `<g class="bar-group${opts.onClick ? " is-link" : ""}" data-index="${i}"><rect class="slot" x="${(pad.l + slot * i).toFixed(1)}" y="${pad.t}" width="${slot.toFixed(1)}" height="${innerH}"/>${path ? `<path class="bar" d="${path}"/>` : gap}${band}${label}${tick}</g>`;
  }).join("");

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="height:${H}px" role="img" aria-label="${esc(opts.ariaLabel)}">${grid}${bars}</svg><div class="chart-tip" hidden></div>`;
  const tip = $(".chart-tip", host);
  const svg = $("svg", host);
  for (const group of $$(".bar-group", host)) {
    const row = rows[Number(group.dataset.index)];
    group.addEventListener("mousemove", (event) => {
      const rect = host.getBoundingClientRect();
      tip.hidden = false;
      tip.innerHTML = opts.tip(row);
      tip.style.left = `${event.clientX - rect.left}px`;
      tip.style.top = `${event.clientY - rect.top}px`;
    });
    group.addEventListener("mouseleave", () => { tip.hidden = true; });
    if (opts.onClick) group.addEventListener("click", () => opts.onClick(row));
  }
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
}

function renderShelf(rows) {
  renderBars($("#shelfChart"), rows.map((r) => ({ key: r.volume_no, label: r.volume_no, value: r.count })), {
    height: 260,
    emptyText: "Raf boş. İlk cilt aktarıldığında burada görünür.",
    ariaLabel: "Ciltlere göre kayıt sayısı",
    showLabel: (r, i) => rows.length <= 12 || i % Math.ceil(rows.length / 12) === 0,
    tip: (r) => `Cilt <b>${esc(r.label)}</b> · ${num(r.value)} kayıt`,
    onClick: (r) => navigate("students", { volume: r.key }),
  });
}

// Diploma yılları: ilk ve son yıl arasındaki boş yıllar da çizilir ki arşivdeki boşluklar görünsün.
function renderYears(rows) {
  const counts = new Map(rows.map((r) => [r.year, r.count]));
  const years = rows.length ? Array.from({ length: rows[rows.length - 1].year - rows[0].year + 1 }, (_, i) => rows[0].year + i) : [];
  const data = years.map((year) => ({ key: year, label: String(year), value: counts.get(year) || 0 }));
  const gaps = data.filter((d) => d.value === 0).length;
  $("#yearsMeta").textContent = data.length ? `${num(rows.length)} yıl${gaps ? `, ${num(gaps)} yıl kayıtsız` : ""}` : "";
  const every = data.length > 24 ? 5 : data.length > 12 ? 2 : 1;
  renderBars($("#yearsChart"), data, {
    height: 240,
    maxBar: 18,
    emptyText: "Diploma tarihi olan kayıt yok.",
    ariaLabel: "Mezuniyet yılına göre kayıt sayısı",
    showLabel: (r) => r.key % every === 0,
    tip: (r) => `<b>${esc(r.label)}</b> · ${r.value ? `${num(r.value)} kayıt` : "kayıt yok"}`,
  });
}

// Son 12 ay, boş aylar dahil.
function renderMonths(rows) {
  const counts = new Map(rows.map((r) => [r.month, r.count]));
  const now = new Date();
  const data = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return { key, label: MONTHS_TR[d.getMonth()], full: `${MONTHS_TR[d.getMonth()]} ${d.getFullYear()}`, value: counts.get(key) || 0 };
  });
  const total = data.reduce((sum, d) => sum + d.value, 0);
  $("#monthsMeta").textContent = total ? `${num(total)} belge` : "";
  renderBars($("#monthsChart"), data, {
    height: 260,
    maxBar: 18,
    emptyText: "Son 12 ayda belge düzenlenmedi.",
    ariaLabel: "Son 12 ayda düzenlenen belge sayısı",
    showLabel: (r, i) => i % 2 === 1,
    tip: (r) => `<b>${esc(r.full)}</b> · ${r.value ? `${num(r.value)} belge` : "belge yok"}`,
  });
}

/* ---------- students ---------- */

let searchTimer = null;

async function renderStudents(params) {
  if (!state.stats) await loadStats();
  const select = $("#volumeFilter");
  const options = state.stats.byVolume.map((v) => `<option value="${esc(v.volume_no)}">Cilt ${esc(v.volume_no)} · ${num(v.count)}</option>`).join("");
  select.innerHTML = `<option value="">Tüm ciltler</option>${options}`;

  if (params.has("q") || params.has("volume")) state.page = 1;
  if (params.has("q")) state.query = params.get("q");
  if (params.has("volume")) state.volume = params.get("volume");
  $("#studentSearch input").value = state.query;
  select.value = state.volume;
  if (select.value !== state.volume) { state.volume = ""; select.value = ""; }

  await loadStudentList();
  if (params.get("new") === "1") showNewStudent();
  else if (params.get("id")) await selectStudent(Number(params.get("id")));
  else if (state.selectedId) await selectStudent(state.selectedId);
  else renderDetailEmpty();
}

async function loadStudentList() {
  const pageSize = state.pageSize;
  const query = new URLSearchParams({ q: state.query, volume: state.volume, limit: String(pageSize), offset: String((state.page - 1) * pageSize) });
  let result = await api(`/api/students?${query}`);
  // Süzgeç daraldıysa sayfa numarası aralığın dışında kalabilir; son sayfaya dön.
  const pages = Math.max(1, Math.ceil(result.total / pageSize));
  if (state.page > pages) {
    state.page = pages;
    query.set("offset", String((pages - 1) * pageSize));
    result = await api(`/api/students?${query}`);
  }
  state.students = result;
  const host = $("#studentList");
  const filtered = state.query || state.volume;
  $("#studentsSubline").textContent = filtered
    ? `${num(result.total)} kayıt eşleşti${pages > 1 ? `, ${num(pages)} sayfa` : ""}.`
    : `Arşivde ${num(result.total)} mezun kaydı var${pages > 1 ? `, ${num(pages)} sayfa` : ""}. Aramak için yazın.`;

  if (!result.items.length) {
    host.innerHTML = `<div class="empty"><strong>${filtered ? "Eşleşen kayıt yok" : "Arşivde kayıt yok"}</strong>${filtered ? "Yazımı değiştirin ya da cilt süzgecini kaldırın." : "Excel aktarımı ile başlayın ya da elle yeni kayıt girin."}</div>`;
    return;
  }
  host.innerHTML = `<table class="table"><thead><tr><th>Adı soyadı</th><th>Kimlik no</th><th class="num">Cilt</th><th class="num">Diploma no</th><th>Diploma tarihi</th><th>Derecesi</th></tr></thead><tbody>${result.items.map((s) => `
    <tr class="is-link" data-id="${s.id}" aria-selected="${s.id === state.selectedId}" tabindex="0"><td class="primary">${esc(s.full_name)}</td><td class="id">${dash(s.identity_number)}</td><td class="num">${esc(s.volume_no)}</td><td class="num">${dash(s.diploma_number)}</td><td class="nowrap">${dash(s.diploma_date)}</td><td>${dash(s.degree)}</td></tr>`).join("")}</tbody></table>${pagerHtml(result.total, pages)}`;
  for (const row of $$("tr[data-id]", host)) {
    row.onclick = () => selectStudent(Number(row.dataset.id));
    row.onkeydown = (event) => { if (event.key === "Enter") selectStudent(Number(row.dataset.id)); };
  }
  bindPager(host, pages);
}

// Sayfa numaraları: ilk, son, geçerli sayfa ve komşuları; aradaki boşluklar "…".
function pageNumbers(current, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const set = new Set([1, pages, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((p) => set.add(p));
  if (current >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((p) => set.add(p));
  const list = [...set].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out = [];
  list.forEach((p, i) => {
    if (i && p - list[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

function pagerHtml(total, pages) {
  const from = (state.page - 1) * state.pageSize + 1;
  const to = Math.min(total, state.page * state.pageSize);
  const numbers = pageNumbers(state.page, pages).map((p) => p === "gap"
    ? `<span class="pager-gap" aria-hidden="true">…</span>`
    : `<button class="pager-btn" type="button" data-page="${p}" ${p === state.page ? 'aria-current="page"' : ""} aria-label="Sayfa ${p}">${num(p)}</button>`).join("");
  return `<div class="pager">
    <div class="pager-info">${num(from)}–${num(to)} / ${num(total)} kayıt</div>
    <nav class="pager-nav" aria-label="Sayfalar">
      <button class="pager-btn" type="button" data-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""} aria-label="Önceki sayfa" title="Önceki sayfa">${icon("chevron-left")}</button>
      ${numbers}
      <button class="pager-btn" type="button" data-page="${state.page + 1}" ${state.page >= pages ? "disabled" : ""} aria-label="Sonraki sayfa" title="Sonraki sayfa">${icon("chevron-right")}</button>
    </nav>
    <label class="pager-size">Sayfada <select class="select" aria-label="Sayfa başına kayıt">${PAGE_SIZES.map((n) => `<option value="${n}" ${n === state.pageSize ? "selected" : ""}>${n}</option>`).join("")}</select></label>
  </div>`;
}

function bindPager(host, pages) {
  for (const button of $$(".pager-btn[data-page]", host)) {
    button.onclick = () => goToPage(Number(button.dataset.page), pages);
  }
  const select = $(".pager-size select", host);
  if (select) select.onchange = () => {
    state.pageSize = Number(select.value);
    try { localStorage.setItem("diploma-page-size", String(state.pageSize)); } catch {}
    state.page = 1;
    loadStudentList().catch((e) => toast(e.message, "bad"));
  };
}

function goToPage(page, pages) {
  if (page < 1 || page > pages || page === state.page) return;
  state.page = page;
  loadStudentList().then(() => $("#studentList")?.scrollIntoView({ block: "start", behavior: "smooth" })).catch((e) => toast(e.message, "bad"));
}

function markSelected() {
  for (const row of $$("#studentList tr[data-id]")) row.setAttribute("aria-selected", String(Number(row.dataset.id) === state.selectedId));
}

$("#studentSearch").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = $("#studentSearch input").value.trim();
    state.page = 1;
    loadStudentList().catch((e) => toast(e.message, "bad"));
  }, 180);
};
$("#studentSearch").onsubmit = (event) => event.preventDefault();
$("#volumeFilter").onchange = () => {
  state.volume = $("#volumeFilter").value;
  state.page = 1;
  loadStudentList().catch((e) => toast(e.message, "bad"));
};
$("#newStudentBtn").onclick = showNewStudent;

// Tarihler veritabanında GG.AA.YYYY saklanır; takvim girişi ISO (YYYY-AA-GG) ister.
function toIsoDate(value) {
  const m = String(value ?? "").trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
}
function fromIsoDate(value) {
  const m = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(value ?? "").trim();
}
function studentFormData(form) {
  const data = Object.fromEntries(new FormData(form));
  for (const [key, , opts] of STUDENT_FIELDS) if (opts?.date && key in data) data[key] = fromIsoDate(data[key]);
  return data;
}

function fieldHtml([key, label, opts = {}], value = "") {
  const attrs = `name="${key}" ${opts.required ? "required" : ""} ${opts.inputmode ? `inputmode="${opts.inputmode}"` : ""} ${opts.maxlength ? `maxlength="${opts.maxlength}"` : ""}`;
  // Takvime çevrilemeyen eski bir değer (ör. yalnız yıl) metin olarak korunur.
  const iso = opts.date ? toIsoDate(value) : "";
  const control = opts.textarea
    ? `<textarea ${attrs} rows="2">${esc(value)}</textarea>`
    : opts.date && (iso || !String(value).trim())
      ? `<input type="date" ${attrs} value="${iso}" min="1900-01-01" max="2100-12-31">`
      : opts.date
        ? `<input ${attrs} value="${esc(value)}" placeholder="GG.AA.YYYY" title="Takvim için GG.AA.YYYY biçiminde kaydedin">`
        : `<input ${attrs} value="${esc(value)}">`;
  return `<label class="field${opts.wide ? " field-wide" : ""}"><span>${esc(label)}</span>${control}</label>`;
}

function renderDetailEmpty() {
  state.selectedId = null;
  markSelected();
  $("#studentDetail").innerHTML = `<div class="empty" style="border-top:0"><strong>Bir mezun seçin</strong>Listeden bir kayda tıklayınca bilgileri burada açılır; buradan düzeltip diploma kayıt örneğini düzenleyebilirsiniz.</div>`;
}

function showNewStudent() {
  state.selectedId = null;
  markSelected();
  const host = $("#studentDetail");
  host.innerHTML = `<div class="detail-head"><h2>Yeni mezun kaydı</h2><button class="btn btn-ghost btn-sm" type="button" id="cancelNew">${icon("x")}Vazgeç</button></div>
    <form class="detail-body" id="studentForm"><div class="form-grid">${STUDENT_FIELDS.map((f) => fieldHtml(f, f[0] === "volume_no" ? state.volume : NEW_STUDENT_DEFAULTS[f[0]] || "")).join("")}</div>
    <p class="status-line" id="studentStatus"></p>
    <div class="detail-actions"><button class="btn btn-primary" type="submit">${icon("save")}Kaydet</button></div></form>`;
  $("#cancelNew").onclick = renderDetailEmpty;
  const submit = async (form, confirmDuplicate = false) => {
    try {
      const created = await api("/api/students", { method: "POST", body: { ...studentFormData(form), confirmDuplicate } });
      toast("Kayıt eklendi.", "good");
      state.stats = null;
      await loadStudentList();
      await selectStudent(created.id);
    } catch (error) {
      setStatus(error.message, "bad");
      if (error.code === "duplicate") toast(error.message, "bad", { label: "Yine de ekle", run: () => submit(form, true) });
    }
  };
  $("#studentForm").onsubmit = (event) => {
    event.preventDefault();
    submit(event.target);
  };
  $("input[name=full_name]", host).focus();
}

function setStatus(message, type) {
  const line = $("#studentStatus");
  if (!line) return;
  line.textContent = message;
  line.className = `status-line${type ? ` is-${type}` : ""}`;
}

async function selectStudent(id) {
  state.selectedId = id;
  markSelected();
  const host = $("#studentDetail");
  let student;
  try {
    student = await api(`/api/students/${id}`);
  } catch (error) {
    renderDetailEmpty();
    toast(error.message, "bad");
    return;
  }
  host.innerHTML = `<div class="detail-head"><h2>${esc(student.full_name)}</h2><button class="btn btn-primary btn-sm" type="button" id="issueBtn">${icon("file-text")}Belge düzenle</button></div>
    <form class="detail-body" id="studentForm"><div class="form-grid">${STUDENT_FIELDS.map((f) => fieldHtml(f, student[f[0]] ?? "")).join("")}</div>
    <p class="status-line" id="studentStatus"></p>
    <div class="detail-actions"><span class="muted small" style="margin-right:auto;align-self:center">${student.source_sheet ? `Kaynak: ${esc(student.source_sheet)}${/^Sayfa/.test(student.source_sheet) ? `, kart ${esc(student.source_row)}` : ` sayfası, satır ${esc(student.source_row)}`}` : "Elle girildi"}</span><button class="btn" type="submit">${icon("save")}Değişiklikleri kaydet</button></div></form>
    <div class="detail-log"><div class="card-head"><div class="card-title">Bu kaydın belge geçmişi</div></div><div id="issueLog"></div></div>`;
  $("#studentForm").onsubmit = async (event) => {
    event.preventDefault();
    try {
      Object.assign(student, await api(`/api/students/${id}`, { method: "PUT", body: studentFormData(event.target) }));
      setStatus("Kaydedildi.", "good");
      state.stats = null;
      await loadStudentList();
      markSelected();
    } catch (error) {
      setStatus(error.message, "bad");
    }
  };
  $("#issueBtn").onclick = () => openIssueDialog(student);
  await loadIssuances(id);
}

async function loadIssuances(id) {
  const host = $("#issueLog");
  if (!host) return;
  const logs = await api(`/api/students/${id}/issuances`);
  if (!logs.length) {
    host.innerHTML = `<div class="empty" style="padding:20px">Bu kayıt için henüz belge düzenlenmedi.</div>`;
    return;
  }
  host.innerHTML = `<ul class="list">${logs.slice(0, 8).map((l) => `
    <li><span class="pill ${l.action === "printed" ? "pill-good" : "pill-neutral"}">${icon(l.action === "printed" ? "printer" : "file-text")}${l.action === "printed" ? "Yazdırıldı" : "Düzenlendi"}</span>
    <div class="grow"><div class="meta">Şablon ${esc(l.template_version)}</div></div>
    ${l.output_path ? `<a class="btn btn-ghost btn-sm" href="/exports/${encodeURIComponent(l.output_path)}" target="_blank" rel="noopener">${icon("external")}PDF</a>` : ""}
    <span class="when">${when(l.created_at)}</span></li>`).join("")}</ul>`;
}

// Dilekçe bölümü için adres, telefon vb. sorulur; son belgedeki değerler ve
// okul bilgileri ön tanımlı gelir.
async function openIssueDialog(selected) {
  const dialog = $("#issueDialog");
  const form = $("#issueForm");
  const id = selected.id;
  let student = selected;
  let settings = {};
  let last = {};
  try {
    // Kart az önce kaydedilmiş olabilir; adres ve telefon güncel kayıttan okunur.
    student = await api(`/api/students/${id}`);
    settings = await api("/api/settings");
    const logs = await api(`/api/students/${id}/issuances`);
    last = safeJson(logs.find((l) => l.details)?.details);
  } catch (error) {
    toast(error.message, "bad");
  }
  const today = new Date().toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" });
  // Takvim alanları ISO ister; takvime çevrilemeyen diploma tarihi (ör. yalnız yıl) boş kalır,
  // sunucu o durumda kayıttaki değeri kullanır.
  const values = {
    applicantName: last.applicantName || student.full_name || "",
    graduation: toIsoDate(student.diploma_date),
    documentDate: toIsoDate(today),
    address: student.address || (last.addressLines || []).join(" "),
    phone: student.phone || last.phone || "",
    relation: last.relation || "oğlu/kızı",
    district: student.district || settings.district || "",
    province: student.province || settings.province || "",
    schoolPhrase: settings.school_phrase || "",
  };
  for (const [key, value] of Object.entries(values)) if (form.elements[key]) form.elements[key].value = value;
  form.onsubmit = async (event) => {
    event.preventDefault();
    dialog.close();
    const data = Object.fromEntries(new FormData(form));
    for (const key of ["graduation", "documentDate"]) data[key] = fromIsoDate(data[key]);
    await issueDocument(id, data);
  };
  $("#issueCancel").onclick = () => dialog.close();
  dialog.showModal();
  form.elements.address.focus();
}

async function issueDocument(id, body) {
  const button = $("#issueBtn");
  if (button) button.disabled = true;
  try {
    const result = await api(`/api/students/${id}/issue`, { method: "POST", body });
    const popup = window.open(result.url, "_blank");
    if (!popup) toast("Tarayıcı açılır pencereyi engelledi. PDF'i belge geçmişinden açabilirsiniz.", "bad");
    toast("Diploma kayıt örneği düzenlendi. Yazdırdıysanız işaretleyin.", "good", {
      label: "Yazdırıldı",
      run: async () => {
        await api(`/api/issuances/${result.issuanceId}/printed`, { method: "POST" });
        state.stats = null;
        toast("Yazdırma kaydedildi.", "good");
        if (state.selectedId === id) loadIssuances(id);
      },
    });
    state.stats = null;
    await loadIssuances(id);
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    if (button) button.disabled = false;
  }
}

/* ---------- import ---------- */

function renderImport() {
  const host = $("#importStage");
  if (!state.importJob) {
    host.innerHTML = `<div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Excel dosyası seç">${icon("upload")}<strong>Excel veya PDF dosyasını buraya bırakın</strong>ya da tıklayıp seçin. Kabul edilen uzantılar: .xls, .xlsx ve e-Okul diploma defteri .pdf, en çok 25 MB.</div><input id="fileInput" type="file" accept=".xls,.xlsx,.pdf" hidden>`;
    const zone = $("#dropzone");
    const input = $("#fileInput");
    zone.onclick = () => input.click();
    zone.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); input.click(); } };
    zone.ondragover = (event) => { event.preventDefault(); zone.classList.add("is-over"); };
    zone.ondragleave = () => zone.classList.remove("is-over");
    zone.ondrop = (event) => { event.preventDefault(); zone.classList.remove("is-over"); const file = event.dataTransfer.files[0]; if (file) inspectFile(file); };
    input.onchange = () => { const file = input.files[0]; if (file) inspectFile(file); };
    return;
  }
  if (state.importJob.result) return renderImportResult();
  renderImportPreview();
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Dosya okunamadı."));
    reader.readAsDataURL(file);
  });
}

async function inspectFile(file) {
  if (!/\.(xls|xlsx|pdf)$/i.test(file.name)) return toast("Yalnızca .xls, .xlsx ve .pdf dosyaları aktarılabilir.", "bad");
  if (file.size > 25 * 1024 * 1024) return toast("Dosya 25 MB sınırını aşıyor.", "bad");
  const zone = $("#dropzone");
  if (zone) zone.innerHTML = `${icon("refresh")}<strong>${esc(file.name)} okunuyor…</strong>`;
  try {
    const data = await readAsBase64(file);
    const job = await api("/api/import/inspect", { method: "POST", body: { filename: file.name, data } });
    const first = job.sheets.find((s) => !s.isTemplate) || job.sheets[0];
    state.importJob = { ...job, selected: first?.name, mapping: { ...(first?.mapping || {}) } };
    renderImport();
  } catch (error) {
    state.importJob = null;
    renderImport();
    toast(error.message, "bad");
  }
}

function renderImportPreview() {
  const job = state.importJob;
  const sheet = job.sheets.find((s) => s.name === job.selected);
  const host = $("#importStage");
  host.innerHTML = `<div class="import-grid">
    <div class="card"><div class="card-head"><div><div class="card-title">${esc(job.filename)}</div><div class="card-sub">${job.sheets[0]?.kind === "pdf" ? `${job.sheets[0].pageCount} sayfalık diploma defteri.` : `${job.sheets.length} sayfa. Aktarılacak cildi seçin.`}</div></div><button class="btn btn-ghost btn-sm" type="button" id="importReset">${icon("x")}Başka dosya</button></div>
      <ul class="sheet-list">${job.sheets.map((s) => `<li><label class="${s.isTemplate ? "is-template" : ""}"><input type="radio" name="sheet" value="${esc(s.name)}" ${s.name === job.selected ? "checked" : ""} ${s.isTemplate ? "disabled" : ""}><div><div class="name">${esc(s.name)}</div><div class="meta">${s.isTemplate ? "Şablon sayfası, aktarılmaz" : s.kind === "pdf" ? `${num(s.rowCount)} öğrenci kartı${s.school ? ` · ${esc(s.school)}` : ""}` : `${num(s.rowCount)} satır${s.suggestedVolume ? ` · cilt ${esc(s.suggestedVolume)}` : " · cilt numarası sayfa adında yok"}`}</div></div></label></li>`).join("")}</ul></div>
    <div class="card" id="mappingCard"></div></div>`;
  $("#importReset").onclick = () => { state.importJob = null; renderImport(); };
  for (const radio of $$("input[name=sheet]", host)) radio.onchange = () => {
    job.selected = radio.value;
    const next = job.sheets.find((s) => s.name === radio.value);
    job.mapping = { ...(next?.mapping || {}) };
    renderImportPreview();
  };
  renderMapping(sheet);
}

function renderMapping(sheet) {
  const job = state.importJob;
  const host = $("#mappingCard");
  if (!sheet) { host.innerHTML = `<div class="empty">Sayfa seçin.</div>`; return; }
  if (sheet.kind === "pdf") return renderPdfMapping(sheet);
  const headerOptions = (selected) => `<option value="">— eşleme yok —</option>${sheet.headers.map((h, i) => `<option value="${i}" ${String(selected) === String(i) ? "selected" : ""}>${esc(h || `Kolon ${i + 1}`)}</option>`).join("")}`;
  const previewCols = sheet.headers.slice(0, 8);
  host.innerHTML = `<div class="card-head"><div><div class="card-title">${esc(sheet.name)} sayfası</div><div class="card-sub">Başlıklar ${sheet.headerRow}. satırda bulundu. Her arşiv alanının hangi sütundan okunacağını onaylayın; adı soyadı boş olan satırlar atlanır.</div></div><span class="card-meta">${num(sheet.rowCount)} satır</span></div>
    <table class="table map-table"><thead><tr><th>Arşiv alanı</th><th>Excel sütunu</th></tr></thead><tbody>${IMPORT_FIELDS.map(([key, label]) => `<tr><td>${esc(label)}</td><td><select class="select" data-field="${key}">${headerOptions(job.mapping[key])}</select></td></tr>`).join("")}</tbody></table>
    <div class="card-head" style="padding-top:18px"><div class="card-title">İlk satırlar</div><span class="card-meta">${previewCols.length < sheet.headers.length ? `ilk ${previewCols.length} sütun` : ""}</span></div>
    <div class="preview-wrap"><table class="table preview-table"><thead><tr>${previewCols.map((h, i) => `<th>${esc(h || `Kolon ${i + 1}`)}</th>`).join("")}</tr></thead><tbody>${sheet.sampleRows.length ? sheet.sampleRows.map((r) => `<tr>${previewCols.map((_, i) => `<td>${dash(r[i])}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${previewCols.length || 1}" class="muted">Sayfada veri satırı yok.</td></tr>`}</tbody></table></div>
    <div class="import-foot"><span class="muted small">${sheet.suggestedVolume ? `Kayıtlar cilt ${esc(sheet.suggestedVolume)} olarak işaretlenecek. Aynı kimlik no, aynı cilt/sıra no veya aynı ciltte aynı ad ile çelişmeyen bilgiler taşıyan kayıtlar mükerrer sayılır ve atlanır.` : "Sayfa adında cilt numarası bulunamadı; aşağıya yazın."}</span>
    <div style="display:flex;gap:8px;align-items:center">${sheet.suggestedVolume ? "" : `<input class="select" id="volumeInput" placeholder="Cilt no" style="width:110px">`}<button class="btn btn-primary" type="button" id="commitBtn">${icon("check")}Cildi arşive aktar</button></div></div>`;
  for (const select of $$("select[data-field]", host)) select.onchange = () => { job.mapping[select.dataset.field] = select.value; };
  $("#commitBtn").onclick = () => commitImport(sheet);
}

function renderPdfMapping(sheet) {
  const host = $("#mappingCard");
  const cols = sheet.headers;
  host.innerHTML = `<div class="card-head"><div><div class="card-title">${esc(sheet.school || "Diploma defteri")}</div><div class="card-sub">${sheet.district ? `${esc(sheet.district)} · ` : ""}${num(sheet.pageCount)} sayfadan ${num(sheet.rowCount)} öğrenci kartı okundu. Adı ve soyadı birleştirilir, diplomanın puanı "Derecesi" alanına yazılır.</div></div><span class="card-meta">${num(sheet.rowCount)} kayıt</span></div>
    ${sheet.warnings?.length ? `<div class="count-line"><span class="pill pill-warn">${icon("alert")}${num(sheet.warnings.length)} uyarı</span><span>${esc(sheet.warnings[0])}</span></div>` : ""}
    <div class="card-head" style="padding-top:12px"><div class="card-title">İlk kartlar</div></div>
    <div class="preview-wrap"><table class="table preview-table"><thead><tr>${cols.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${sheet.sampleRows.map((r) => `<tr>${cols.map((_, i) => `<td>${dash(r[i])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <div class="import-foot"><span class="muted small">Kayıtlar yazdığınız cilt adıyla saklanır; dosya adından önerilen değer düzenlenebilir. Aynı kimlik no, aynı cilt/diploma no veya aynı ad ile çelişmeyen bilgiler taşıyan kayıtlar atlanır.</span>
    <div style="display:flex;gap:8px;align-items:center"><input class="select" id="volumeInput" placeholder="Cilt" value="${esc(sheet.suggestedVolume || "")}" style="width:130px" aria-label="Cilt"><button class="btn btn-primary" type="button" id="commitBtn">${icon("check")}Defteri arşive aktar</button></div></div>`;
  $("#commitBtn").onclick = () => commitImport(sheet);
}

async function commitImport(sheet, confirmRepeat = false) {
  const job = state.importJob;
  const volumeNo = sheet.kind === "pdf" ? ($("#volumeInput")?.value || "").trim() : sheet.suggestedVolume || ($("#volumeInput")?.value || "").trim();
  if (!volumeNo) return toast("Cilt numarası girin.", "bad");
  if (job.mapping.full_name === "" || job.mapping.full_name === undefined) return toast("Adı soyadı sütununu eşleyin.", "bad");
  const button = $("#commitBtn");
  button.disabled = true;
  button.textContent = "Aktarılıyor…";
  try {
    const result = await api("/api/import/commit", { method: "POST", body: { importId: job.importId, sheetName: sheet.name, volumeNo, mapping: job.mapping, confirmRepeat } });
    job.result = { ...result, sheet: sheet.name };
    state.stats = null;
    renderImport();
    toast(`${num(result.accepted)} kayıt arşive alındı.`, "good");
  } catch (error) {
    button.disabled = false;
    button.innerHTML = `${icon("check")}${sheet.kind === "pdf" ? "Defteri arşive aktar" : "Cildi arşive aktar"}`;
    if (error.code === "repeat") toast(error.message, "bad", { label: "Yine de aktar", run: () => commitImport(sheet, true) });
    else toast(error.message, "bad");
  }
}

function renderImportResult() {
  const r = state.importJob.result;
  $("#importStage").innerHTML = `<div class="result-grid">
    <div class="kpis" style="grid-column:1/-1;grid-template-columns:repeat(3,1fr)"><div class="kpi"><div class="kpi-label">Okunan satır</div><div class="kpi-value">${num(r.total)}</div><div class="kpi-note">${esc(r.sheet)} sayfası, cilt ${esc(r.volumeNo)}</div></div><div class="kpi"><div class="kpi-label">Arşive alınan</div><div class="kpi-value">${num(r.accepted)}</div><div class="kpi-note">Yeni mezun kaydı</div></div><div class="kpi"><div class="kpi-label">Mükerrer olduğu için atlanan</div><div class="kpi-value">${num(r.rejected)}</div><div class="kpi-note${r.rejected ? " is-warn" : ""}">${r.rejected ? "Mevcut kayıtlarla eşleşti" : "Çakışma yok"}</div></div></div>
    ${r.duplicates.length ? `<div class="card" style="grid-column:1/-1"><div class="card-head"><div class="card-title">Atlanan satırlar</div><span class="card-meta">${num(r.duplicates.length)} satır</span></div><table class="table"><thead><tr><th class="num">${r.sheet === "Diploma Defteri" ? "Kart" : "Excel satırı"}</th><th>Eşleşme</th><th>Mevcut kayıt</th></tr></thead><tbody>${r.duplicates.slice(0, 50).map((d) => `<tr><td class="num">${d.row}</td><td>${DUPLICATE_REASONS[d.reason] || "Mükerrer"}</td><td><a class="link" href="#/students?id=${d.existingId}">Kaydı aç</a></td></tr>`).join("")}</tbody></table>${r.duplicates.length > 50 ? `<div class="count-line">İlk 50 satır gösteriliyor.</div>` : ""}</div>` : ""}
    <div style="grid-column:1/-1;display:flex;gap:8px"><a class="btn btn-primary" href="#/students?volume=${encodeURIComponent(r.volumeNo)}">${icon("users")}Cilt ${esc(r.volumeNo)} mezunlarını gör</a><button class="btn" type="button" id="importAgain">${icon("upload")}Başka sayfa aktar</button></div></div>`;
  $("#importAgain").onclick = () => { state.importJob = null; renderImport(); };
}

/* ---------- history ---------- */

for (const tab of $$(".tab")) tab.onclick = () => { state.historyTab = tab.dataset.tab; renderHistory().catch((e) => toast(e.message, "bad")); };

async function renderHistory() {
  for (const tab of $$(".tab")) tab.setAttribute("aria-selected", String(tab.dataset.tab === state.historyTab));
  const host = $("#historyTable");
  if (state.historyTab === "issuances") {
    const rows = await api("/api/issuances");
    $("#historySubline").textContent = rows.length ? `Son ${num(rows.length)} belge işlemi. Her düzenleme ve yazdırma ayrı satırdır.` : "Henüz belge düzenlenmedi.";
    host.innerHTML = rows.length
      ? `<table class="table"><thead><tr><th>Mezun</th><th>İşlem</th><th class="num">Cilt</th><th class="num">Diploma no</th><th>Şablon</th><th>Tarih</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td class="primary"><a href="#/students?id=${r.student_id}">${esc(r.full_name)}</a></td><td><span class="pill ${r.action === "printed" ? "pill-good" : "pill-neutral"}">${icon(r.action === "printed" ? "printer" : "file-text")}${r.action === "printed" ? "Yazdırıldı" : "Düzenlendi"}</span></td><td class="num">${esc(r.volume_no)}</td><td class="num">${dash(r.diploma_number)}</td><td>${esc(r.template_version)}</td><td class="when">${when(r.created_at)}</td><td class="actions">${r.output_path ? `<a class="btn btn-ghost btn-sm" href="/exports/${encodeURIComponent(r.output_path)}" target="_blank" rel="noopener">${icon("external")}PDF</a>` : ""}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty" style="border-top:0"><strong>Belge geçmişi boş</strong>Mezunlar ekranından bir kayıt seçip belge düzenleyince burada listelenir.</div>`;
  } else {
    const rows = await api("/api/imports");
    $("#historySubline").textContent = rows.length ? `${num(rows.length)} Excel aktarımı yapıldı.` : "Henüz Excel aktarımı yapılmadı.";
    host.innerHTML = rows.length
      ? `<table class="table"><thead><tr><th>Dosya</th><th>Sayfa</th><th class="num">Cilt</th><th class="num">Okunan</th><th class="num">Aktarılan</th><th class="num">Atlanan</th><th>Durum</th><th>Tarih</th><th></th></tr></thead><tbody>${rows.map((r) => { const d = safeJson(r.details); const reverted = r.status === "reverted"; return `<tr data-import="${r.id}"><td class="ellipsis primary" title="${esc(r.filename)}">${esc(r.filename)}</td><td class="nowrap">${dash(d.sheet)}</td><td class="num">${dash(d.volumeNo)}</td><td class="num">${num(r.total_rows)}</td><td class="num">${num(r.accepted_rows)}</td><td class="num">${r.rejected_rows ? num(r.rejected_rows) : '<span class="dash">0</span>'}</td><td><span class="pill ${reverted ? "pill-warn" : "pill-good"}">${icon(reverted ? "history" : "circle-check")}${reverted ? "Geri alındı" : "Arşivde"}</span></td><td class="when">${when(r.created_at)}</td><td class="actions">${!reverted && r.accepted_rows ? `<button class="btn btn-ghost btn-sm btn-danger" type="button" data-revert="${r.id}">${icon("x")}Geri al</button>` : ""}</td></tr>`; }).join("")}</tbody></table>`
      : `<div class="empty" style="border-top:0"><strong>Aktarım geçmişi boş</strong><a class="btn btn-sm" href="#/import">${icon("upload")}Excel aktarımına git</a></div>`;
    for (const button of $$("button[data-revert]", host)) button.onclick = () => revertImport(Number(button.dataset.revert), rows.find((r) => r.id === Number(button.dataset.revert)));
  }
}

function revertImport(id, row, force = false) {
  const d = safeJson(row?.details);
  const run = async () => {
    try {
      const result = await api(`/api/imports/${id}${force ? "?force=1" : ""}`, { method: "DELETE" });
      state.stats = null;
      toast(`${num(result.removed)} kayıt arşivden kaldırıldı.`, "good");
      await renderHistory();
    } catch (error) {
      if (error.code === "edited") toast(error.message, "bad", { label: "Yine de sil", run: () => revertImport(id, row, true) });
      else toast(error.message, "bad");
    }
  };
  if (force) return run();
  toast(`${dash(d.sheet)} sayfasından gelen ${num(row?.accepted_rows)} kayıt silinecek. Belge düzenlenmiş kayıtlar varsa işlem reddedilir.`, "neutral", { label: "Evet, geri al", run });
}

/* ---------- settings ---------- */

async function renderSettings() {
  const settings = await api("/api/settings");
  const form = $("#settingsForm");
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements[key];
    if (input) input.value = value || "";
  }
  $("#settingsStamp").textContent = settings.updated_at ? `Son güncelleme ${when(settings.updated_at)}` : "";
}
$("#settingsForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const saved = await api("/api/settings", { method: "PUT", body: Object.fromEntries(new FormData(event.target)) });
    $("#settingsStamp").textContent = `Son güncelleme ${when(saved.updated_at)}`;
    setSchoolName(saved.school_name);
    state.stats = null;
    toast("Okul bilgileri kaydedildi.", "good");
  } catch (error) {
    toast(error.message, "bad");
  }
};

/* ---------- boot ---------- */

async function boot() {
  hideGate();
  // Kenar çubuğundaki kurum adı hangi ekran açılırsa açılsın dolu olsun.
  api("/api/settings").then((settings) => setSchoolName(settings?.school_name)).catch(() => {});
  await route();
}

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (state.view !== "students") navigate("students");
    $("#studentSearch input")?.focus();
  }
});

// Tema ya da genişlik değişince grafikler yeniden çizilir.
function renderStatsCharts() {
  if (state.view !== "stats" || !state.stats) return;
  renderYears(state.stats.byYear);
  renderShelf(state.stats.byVolume);
  renderMonths(state.stats.byMonth);
}

window.addEventListener("resize", () => {
  renderStatsCharts();
});

// Masaüstü paketinde pencere açık olduğu sürece sunucuya yaşam sinyali gönderilir;
// sinyal kesilince sunucu kendini kapatır.
function startHeartbeat() {
  const beat = () => fetch("/api/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  beat();
  setInterval(beat, 10000);
}

(async () => {
  applyThemeLabel();
  try {
    const session = await fetch("/api/session").then((r) => r.json());
    if (session.version) $("#aboutVersion").textContent = `Sürüm ${session.version}`;
    if (session.desktop) startHeartbeat();
    if (!session.authenticated) return showGate();
    await boot();
  } catch {
    showGate();
  }
})();
