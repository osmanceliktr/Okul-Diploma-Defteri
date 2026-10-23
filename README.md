# Diploma Kayıt Yönetimi

Yerel okul arşivleri için Node.js ve SQLite tabanlı masaüstü web uygulaması.

Uygulama; mezun arama ve düzenleme, Excel/PDF aktarımı, diploma kayıt örneği oluşturma, yazdırma geçmişi ve okul bilgilerini tek bir arayüzde birleştirir.

> **Veri güvenliği:** Diploma kayıtları kişisel veri içerir. Gerçek veritabanını, yüklenen dosyaları, üretilen PDF'leri veya orijinal arşiv dosyalarını herkese açık bir GitHub deposuna yüklemeyin. README yalnızca uygulama kullanımını belgeler.

## İçindekiler

- [Özellikler](#özellikler)
- [Gereksinimler](#gereksinimler)
- [Kurulum ve çalıştırma](#kurulum-ve-çalıştırma)
- [Yapılandırma](#yapılandırma)
- [Veri ve çıktı konumları](#veri-ve-çıktı-konumları)
- [PDF belgesi](#pdf-belgesi)
- [Excel aktarımı](#excel-aktarımı)
- [PDF aktarımı](#pdf-aktarımı)
- [Masaüstü paketi](#masaüstü-paketi)
- [Geliştirme](#geliştirme)
- [Sınırlamalar](#sınırlamalar)

## Özellikler

- Mezunları ad, T.C. kimlik numarası, diploma numarası veya baba adıyla arama.
- Türkçe karakter farklarını göz ardı eden arama ve mükerrer kayıt kontrolü.
- Cilt filtresi ve 25, 50 veya 100 kayıtlık sayfalama.
- Mezun ve diploma bilgilerini düzenleme.
- Excel'den cilt bazlı kayıt aktarımı ve alan eşleme önizlemesi.
- e-Okul diploma defteri PDF'lerinden metin tabanlı kayıt aktarımı.
- Tek A4 sayfasında dilekçe ve diploma kayıt örneği PDF'i oluşturma.
- Belge düzenleme, yazdırma ve aktarım geçmişi.
- Mezuniyet yılları, ciltler, belge talepleri ve eksik bilgiler için istatistikler.
- Açık/koyu tema ve tarayıcıda saklanan kullanıcı tercihleri.
- Node.js kurulu olmayan bilgisayarlar için taşınabilir Windows masaüstü paketi.

## Gereksinimler

- Node.js **22.13 veya üzeri**
- Windows'ta PDF yazı tipi gömme için Arial veya uyumlu bir yazı tipi
- Excel aktarımı için `xlsx` paketi (kurulumda `npm install` ile gelir)

Uygulama, Node.js'in yerleşik `node:sqlite` API'sini kullandığı için ayrıca SQLite sunucusu kurulması gerekmez.

## Kurulum ve çalıştırma

Proje klasöründe PowerShell açın:

```powershell
npm install
npm test
npm start
```

Ardından tarayıcıda [http://localhost:3001](http://localhost:3001) adresini açın.

Geliştirme sırasında dosya değişikliklerini izlemek için:

```powershell
npm run dev
```

Sunucu varsayılan olarak yalnızca yerel bilgisayardan (`127.0.0.1`) erişilebilir. Port, `PORT` ortam değişkeniyle değiştirilebilir.

## Yapılandırma

Proje kökünde `.env` dosyası oluşturup aşağıdaki değerleri tanımlayabilirsiniz:

```dotenv
DIPLOMA_PASSWORD=guvenli-bir-parola
PORT=3001
```

- `DIPLOMA_PASSWORD`: uygulama giriş parolasıdır.
- `PORT`: isteğe bağlı HTTP portudur; varsayılan değer `3001`'dir.

`.env` dosyası ve içindeki parola GitHub'a gönderilmemelidir. `DIPLOMA_PASSWORD` tanımlı değilse uygulama yalnızca geliştirme amacıyla `12345` parolasını kullanır ve konsola uyarı yazar.

## Uygulama bölümleri

### Mezunlar

Mezunlar ad soyad, T.C. kimlik numarası, diploma numarası veya baba adıyla aranabilir. Cilt filtresi, sayfalama ve `Ctrl+K` kısayolu desteklenir.

Doğum tarihi ve diploma tarihi takvimden seçilebilir. Eski kayıtlardaki yalnızca yıl gibi takvime çevrilemeyen değerler metin olarak korunur. Ana adı ve notlar formda gösterilmese de aktarılmış değerler veritabanında saklanır.

### Belge geçmişi

Düzenleme, yazdırma ve veri aktarımı işlemleri izlenebilir. Yanlış bir Excel aktarımı, belge düzenlenmiş kayıt içermiyorsa **Belge geçmişi → Excel aktarımları → Geri al** seçeneğiyle geri alınabilir.

### İstatistikler

Mezun, cilt ve belge sayıları; mezuniyet yılı dağılımı; cilt rafı; son 12 aydaki belge talepleri; eksik kimlik, tarih, baba adı, diploma ve adres bilgileri görüntülenebilir.

### Okul bilgileri

PDF başlığı, imza alanı, dilekçe başlığı, adres bloğu ve resmi yazı cümlesinde kullanılacak okul bilgileri buradan yönetilir.

## Veri ve çıktı konumları

| Konum | İçerik |
| --- | --- |
| `data/diploma.db` | SQLite veritabanı |
| `data/exports/` | Oluşturulan PDF'ler |
| `data/backups/` | Veri düzeltmelerinden önce alınan yedekler |
| `data/diploma.log` | Masaüstü paketinin başlangıç günlüğü |

Orijinal Excel dosyası uygulama tarafından değiştirilmez. `data/`, yüklenen dosyalar, PDF çıktıları ve gerçek `.env` dosyası kişisel veya gizli veri içerebileceğinden paylaşılmamalıdır.

## PDF belgesi

Oluşturulan belge tek A4 sayfasından oluşur:

1. **Dilekçe:** Üst bölümde müdürlük başlığı, ilçe, mezuniyet tarihi, kayıp diploma dilekçesi, tarih, adres, telefon ve dilekçe sahibinin adı bulunur.
2. **Diploma kayıt örneği:** Alt bölümde kimlik, doğum, baba adı, yakınlık, ad soyad, okul ifadesi, derece, diploma tarihi ve diploma numarası bilgileri yer alır. Boş alanlar cümleden çıkarılır.

PDF'e Arial (`arial.ttf` ve `arialbd.ttf`) alt küme olarak gömülür; Türkçe karakterler ve metin kopyalama korunur. Farklı bir yazı tipi dizini için `DIPLOMA_FONT_DIR` kullanılabilir. Alternatif olarak `fonts/` klasörüne Arial, Liberation Sans veya DejaVu Sans eklenebilir. Uygun yazı tipi bulunamazsa Helvetica ile sadeleştirilmiş çıktı üretilir.

## Excel aktarımı

Excel dosyasını aktarım ekranına sürükleyip bırakın. Sayfayı ve alan eşlemesini onayladıktan sonra kayıtlar içeri alınır.

- `DİPLOMA KAYIT ÖRNEĞİ` sayfası şablon olarak tanınır ve aktarılmaz.
- Sayfa adındaki cilt numarası ile aktarılacak cilt numarası eşleşmelidir.
- İlk 15 satırdaki başlıklar otomatik algılanır; eşleme önizlemede değiştirilebilir.
- `Adı Soyadı`, `Diploma Numarası` ve `Tarihi` alanları uygun kayıt alanlarına eşlenir.
- Aynı T.C. kimlik numarası, cilt/diploma numarası veya çelişmeyen aynı kişi bilgileri mükerrer kabul edilir.
- Kimlik numarası olmayan kayıtlarda aynı ad soyad ile diploma tarihi veya diploma numarası da mükerrerlik kontrolüne katılır.
- Daha önce aktarılmış aynı dosya ve sayfa için uygulama onay ister.

## PDF aktarımı

Metin tabanlı e-Okul **İlköğretim Kurumları Diploma Defteri** PDF'leri, sayfa başına dört öğrenci kartı düzeniyle okunabilir. Ad soyad, kimlik numarası, baba/ana adı, doğum bilgileri, diploma numarası, diploma tarihi ve puan bilgisi alınır.

Dosya adındaki yıl aralığı, örneğin `2007-2011`, cilt adı olarak önerilir. Taranmış/görüntü tabanlı PDF'ler desteklenmez.

## Masaüstü paketi

Node.js kurulu olmayan Windows bilgisayarlar için Node.js çalışma zamanını içeren tek bir paket oluşturulabilir:

```powershell
npm run build:desktop
```

Çıktı:

- `dist/DiplomaKayit/`
- `dist/DiplomaKayit.zip`

Paketin içinde `DiplomaKayit.exe`, boş bir `data/` klasörü, `.env` şablonu ve `OKUYUN.txt` bulunur. Gerçek `.env` dosyası pakete kopyalanmaz.

Hedef bilgisayarda:

1. ZIP dosyasını yazılabilir bir klasöre açın; örneğin `C:\DiplomaKayit`.
2. `.env` içindeki `DIPLOMA_PASSWORD` değerini değiştirin.
3. `DiplomaKayit.exe` için masaüstü kısayolu oluşturun.
4. Mevcut arşivi taşımak için uygulama kapalıyken `data/diploma.db` dosyasını, varsa `-wal` ve `-shm` dosyalarıyla birlikte paketin yanındaki `data/` klasörüne kopyalayın.

Exe, Microsoft Edge'i; Edge yoksa Chrome'u adres çubuğu olmayan pencere modunda açar. Hata ayıklama için şu komut kullanılabilir:

```powershell
npm run build:desktop -- --console
```

## Geliştirme

- Sunucu `src/server.js` içindeki `createApp({ dbPath, exportDir, password })` fabrikasıyla oluşturulur.
- Testler geçici veritabanı kullanır.
- Arayüz `public/` altında bağımlılıksız HTML, CSS ve JavaScript dosyalarından oluşur.
- İkonlar, ağ bağlantısı gerektirmeyen `public/icons.svg` Lucide sprite'ından gelir.
- PDF şablonu değiştiğinde `src/pdf.js` içindeki `TEMPLATE_VERSION` güncellenmelidir.
- Masaüstü paketi `desktop/` altında bulunur; giriş noktası `main.js`, yardımcılar `launcher.js`, derleme hattı `build.js` dosyasıdır.

Testleri çalıştırmak için:

```powershell
npm test
```

## Sınırlamalar

- Sadece metin tabanlı PDF aktarımı desteklenir; taranmış PDF'ler okunmaz.
- Uygulama varsayılan olarak yerel bilgisayara bağlıdır ve ağ üzerinden çok kullanıcılı erişim için tasarlanmamıştır.
- Excel ve PDF aktarımı öncesinde dosyanın doğru sayfa, cilt ve alan eşleşmesine sahip olduğu kontrol edilmelidir.

## Lisans ve veri kullanımı

Bu proje okul arşivinin yerel kullanımı için hazırlanmıştır. Lisans ve veri paylaşım koşulları ayrıca belirlenene kadar kaynak kodunu ve özellikle kişisel veri içeren arşiv dosyalarını izinsiz dağıtmayın.
