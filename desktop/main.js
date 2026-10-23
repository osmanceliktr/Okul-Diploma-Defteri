"use strict";
// Masaüstü giriş noktası: tek exe (Node SEA) içinde sunucuyu başlatır ve arayüzü
// Edge/Chrome'un pencere (--app) modunda açar. Pencere kapanınca sunucu kapanır.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const util = require("node:util");
const { spawn, spawnSync } = require("node:child_process");
const sea = require("node:sea");
const { createApp } = require("../src/server");
const { browserCandidates, findBrowser, browserArgs, isOurApp, instanceId, choosePort, createShutdownController } = require("./launcher");

const PUBLIC_FILES = ["index.html", "app.js", "style.css", "icons.svg"];
const isSea = sea.isSea();
const appDir = isSea ? path.dirname(process.execPath) : path.join(__dirname, "..");
const dataDir = path.join(appDir, "data");
const INSTANCE = instanceId(appDir);

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, "diploma.log"), `${line}\n`);
  } catch {}
}

function showError(message) {
  log(`HATA: ${message}`);
  try {
    const text = String(message).replace(/'/g, "''");
    spawnSync("powershell", ["-NoProfile", "-Command", `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text}', 'Diploma Kayıt') | Out-Null`], { stdio: "ignore", timeout: 15000 });
  } catch {}
}

// Exe'nin yanındaki .env okunur (Not Defteri'nin eklediği .txt uzantısı ve UTF-8 BOM tolere edilir).
// Önceden tanımlı ortam değişkenleri ezilmez.
function loadEnv() {
  const candidates = [".env", ".env.txt"].map((name) => path.join(appDir, name));
  const envPath = candidates.find((file) => fs.existsSync(file));
  if (!envPath) {
    log(`Ayar dosyası yok: ${candidates[0]}`);
    return;
  }
  try {
    const text = fs.readFileSync(envPath, "utf8").replace(/^﻿/, "");
    const parsed = util.parseEnv(text);
    for (const [key, value] of Object.entries(parsed)) if (!(key in process.env)) process.env[key] = value;
    log(`Ayar dosyası okundu: ${envPath}${envPath.endsWith(".txt") ? " (.env.txt; dosya adını .env yapmanız önerilir)" : ""}`);
  } catch (error) {
    log(`Ayar dosyası okunamadı (${envPath}): ${error.message}`);
  }
}

function embeddedFiles() {
  if (!isSea) return null;
  return new Map(PUBLIC_FILES.map((name) => [name, Buffer.from(sea.getAsset(name))]));
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/session", timeout: 1500 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 && isOurApp(JSON.parse(text), INSTANCE) ? "ours" : "busy");
        } catch {
          resolve("busy");
        }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve("busy"); });
    req.on("error", (error) => resolve(error.code === "ECONNREFUSED" ? "free" : "busy"));
  });
}

function openWindow(url, onExit) {
  // Otomatik sınama için pencere açmadan çalıştırma (DiplomaKayit.exe --no-window).
  if (process.argv.includes("--no-window") || process.env.DIPLOMA_NO_WINDOW) {
    log("Pencere açılmadı (--no-window).");
    return;
  }
  const browser = findBrowser(browserCandidates(), fs.existsSync);
  if (browser) {
    const profile = path.join(process.env.LOCALAPPDATA || dataDir, "DiplomaKayit", "browser");
    const child = spawn(browser, browserArgs(url, profile), { stdio: "ignore" });
    child.on("exit", () => onExit());
    child.on("error", (error) => { log(`Tarayıcı başlatılamadı: ${error.message}`); onExit(); });
    log(`Pencere açıldı: ${browser}`);
    return;
  }
  log("Edge veya Chrome bulunamadı; varsayılan tarayıcı açılıyor.");
  spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function main() {
  loadEnv();
  const preferred = Number(process.env.PORT) || 3001;
  let { port, reuse } = await choosePort({ preferred, probe });
  if (reuse) {
    log(`Çalışan kopya bulundu (port ${port}); yalnızca pencere açılıyor.`);
    openWindow(`http://127.0.0.1:${port}/`, () => process.exit(0));
    return;
  }

  let app;
  const controller = createShutdownController({
    closeServer: () => {
      log("Pencere kapandı; sunucu durduruluyor.");
      try { app.server.close(); } catch {}
      try { app.db.close(); } catch {}
      process.exit(0);
    },
  });
  app = createApp({
    dbPath: path.join(dataDir, "diploma.db"),
    exportDir: path.join(dataDir, "exports"),
    publicFiles: embeddedFiles(),
    desktop: true,
    instance: INSTANCE,
    password: process.env.DIPLOMA_PASSWORD,
    onHeartbeat: controller.heartbeat,
  });
  // Port denetimi ile dinleme arasında başkası portu almış olabilir; sonraki portu dene.
  for (let attempt = 0; ; attempt++) {
    try {
      await listen(app.server, port);
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || attempt >= 9) throw error;
      port++;
    }
  }
  const url = `http://127.0.0.1:${port}/`;
  log(`Sunucu ${url} adresinde (${isSea ? "paket" : "geliştirme"}; klasör ${appDir}; kopya ${INSTANCE}).`);
  if (!process.env.DIPLOMA_PASSWORD) log("DIPLOMA_PASSWORD tanımlı değil; exe yanındaki .env dosyasına yazın.");
  openWindow(url, controller.browserExited);
}

main().catch((error) => {
  showError(`Uygulama başlatılamadı: ${error.message}`);
  process.exit(1);
});
