"use strict";
// Masaüstü paketi: esbuild ile tek dosyaya derler, Node SEA ile DiplomaKayit.exe üretir,
// dağıtım klasörünü ve zip'i hazırlar. Kullanım: npm run build:desktop
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { setPeSubsystem, PE_SUBSYSTEM_GUI } = require("./launcher");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, "build");
const DIST = path.join(ROOT, "dist");
const PKG = path.join(DIST, "DiplomaKayit");
const EXE = path.join(PKG, "DiplomaKayit.exe");
const slash = (p) => p.replace(/\\/g, "/");

function step(title) {
  console.log(`\n== ${title}`);
}

function bundle() {
  step("Kaynak tek dosyaya derleniyor (esbuild)");
  const esbuild = require("esbuild");
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, "desktop", "main.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: path.join(BUILD, "bundle.js"),
    keepNames: true,
    minify: false,
    logLevel: "info",
  });
  if (result.errors.length) throw new Error("esbuild hataları var.");
  const text = fs.readFileSync(path.join(BUILD, "bundle.js"), "utf8");
  if (!/node_modules\/xlsx\//.test(text)) {
    throw new Error("xlsx pakete girmedi; önce `npm install xlsx` çalıştırın.");
  }
}

function buildSea() {
  step("Tek çalıştırılabilir dosya üretiliyor (Node SEA)");
  // Node 25.5+ kopyalama ve gömmeyi tek adımda yapar; eski sürümlerde postject kullanılır.
  const supportsBuildSea = Number(process.versions.node.split(".")[0]) >= 25;
  const config = {
    main: slash(path.join(BUILD, "bundle.js")),
    output: slash(supportsBuildSea ? EXE : path.join(BUILD, "sea-prep.blob")),
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
    execArgv: ["--disable-warning=ExperimentalWarning"],
    assets: Object.fromEntries(["index.html", "app.js", "style.css", "icons.svg"].map((name) => [name, slash(path.join(ROOT, "public", name))])),
  };
  const configPath = path.join(BUILD, "sea-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  fs.mkdirSync(PKG, { recursive: true });
  if (supportsBuildSea) {
    execFileSync(process.execPath, ["--build-sea", configPath], { stdio: "inherit" });
    return;
  }
  // Eski Node: blob üret, node.exe'yi kopyala, postject ile göm.
  execFileSync(process.execPath, ["--experimental-sea-config", configPath], { stdio: "inherit" });
  fs.copyFileSync(process.execPath, EXE);
  const npx = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  execFileSync(process.execPath, [npx, "--yes", "postject", EXE, "NODE_SEA_BLOB", config.output, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { stdio: "inherit" });
}

// Konsol penceresini gizle: exe'yi pencere alt sistemine çevir. `--console` ile atlanır (hata ayıklama).
function hideConsole() {
  if (process.argv.includes("--console") || process.env.DIPLOMA_CONSOLE) {
    step("Konsol penceresi korunuyor (--console)");
    return;
  }
  step("Konsol penceresi gizleniyor (PE subsystem -> pencere)");
  const image = fs.readFileSync(EXE);
  const previous = setPeSubsystem(image, PE_SUBSYSTEM_GUI);
  fs.writeFileSync(EXE, image);
  console.log(`Subsystem ${previous} -> ${PE_SUBSYSTEM_GUI}`);
}

function packageFiles() {
  step("Dağıtım klasörü hazırlanıyor");
  fs.mkdirSync(path.join(PKG, "data"), { recursive: true });
  fs.writeFileSync(path.join(PKG, "data", ".keep"), "");
  // Gerçek .env kopyalanmaz; parola hedef bilgisayarda yazılır.
  fs.writeFileSync(path.join(PKG, ".env"), "DIPLOMA_PASSWORD=degistirin\r\n# PORT=3001\r\n");
  fs.writeFileSync(path.join(PKG, "OKUYUN.txt"), [
    "DİPLOMA KAYIT - Masaüstü paketi",
    "",
    "Kurulum",
    "1. Bu klasörü bilgisayarda kalıcı bir yere kopyalayın (ör. C:\\DiplomaKayit).",
    "   Program Files altına koymayın; veri klasörü yazılabilir olmalıdır.",
    "2. .env dosyasını Not Defteri ile açıp DIPLOMA_PASSWORD satırına giriş parolasını yazın.",
    "3. DiplomaKayit.exe'ye sağ tıklayıp Gönder > Masaüstü (kısayol oluştur) ile kısayol yapın.",
    "",
    "Kullanım",
    "- DiplomaKayit.exe çift tıklandığında uygulama penceresi açılır; pencere kapanınca program kapanır.",
    "- Siyah terminal penceresi açılmaz; program arka planda çalışır ve kayıtlarını data\\diploma.log dosyasına yazar.",
    "- İlk açılışta Windows SmartScreen uyarı verebilir: Daha fazla bilgi > Yine de çalıştır.",
    "- Tüm veriler bu klasördeki data\\ içinde tutulur (diploma.db ve exports). Yedek için data\\ klasörünü kopyalayın.",
    "- Mevcut bir arşivi taşımak için uygulama kapalıyken data\\diploma.db dosyasını (varsa -wal ve -shm ile birlikte) buraya kopyalayın.",
    "- Sorun olursa data\\diploma.log dosyasına bakın.",
    "",
  ].join("\r\n"));
}

function zip() {
  step("Zip oluşturuluyor");
  const target = path.join(DIST, "DiplomaKayit.zip");
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Force -Path '${PKG}' -DestinationPath '${target}'`], { stdio: "inherit" });
    console.log(`Zip: ${target}`);
  } catch (error) {
    console.warn(`Zip oluşturulamadı (${error.message}); klasör yine de hazır: ${PKG}`);
  }
}

fs.rmSync(BUILD, { recursive: true, force: true });
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
bundle();
buildSea();
hideConsole();
packageFiles();
zip();
const size = fs.statSync(EXE).size;
console.log(`\nTamam: ${EXE} (${(size / 1024 / 1024).toFixed(0)} MB)`);
