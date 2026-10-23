# Diploma Kayıt Repository Rules

Bu kurallar `D:\DIPLOMA` içindeki diploma kayıt uygulaması ve arşivi için geçerlidir.

## Veri ve gizlilik

- `data/diploma.db`, `data/exports/`, yüklenen çalışma kitapları ve gerçek diploma kayıtları hassas veridir; bunları commit etme, dış servislere yükleme veya sohbet çıktısına koyma.
- Testlerde anonim ve sentetik değerler kullan. Gerçek kimlik numarası, öğrenci adı veya satır içeriğini örnek olarak yazma.
- Orijinal `DİPLOMA KAYIT BİLGİLER 1974-1997.xls` dosyasını değiştirme, yeniden adlandırma veya `.xlsx` formatına dönüştürme; bunun için açık onay ve ayrı doğrulama gerekir.
- Geçici Excel kilit dosyalarını (`~$*.xls`) ve oluşturulmuş PDF'leri kaynak kodla birlikte izleme.

## Kod ve yapı

- Mevcut CommonJS ve Node.js yaklaşımını koru; yeni bağımlılık eklemeden önce gerekliliğini değerlendir.
- SQL sorgularında parametre kullan ve HTTP girdilerini doğrula.
- Türkçe karakterleri ve dosya kodlamasını koru; anlamsız bir metin kodlaması düzeltmesi yapmadan önce etkilenen dosyaları kontrol et.
- `src/` uygulama mantığı, `public/` tarayıcı arayüzü, `test/` testler, `data/` yerel çalışma verileri içindir.
- Veritabanı değişikliğinde geriye dönük açılış, mevcut kayıtların okunması ve ilgili indeks/benzersizlik davranışını kontrol et.

## Doğrulama ve teslim

- Kod değişikliklerinden sonra `npm test` çalıştırılmadan işi tamamlanmış sayma.
- Değişiklik veri aktarımı, PDF veya görünür arayüzü etkiliyorsa ilgili akışı ayrıca spot-check et.
- Hata mesajlarında kişisel veri veya tam dosya içeriği gösterme.
- Commit/PR açıklamasında değişen dosyaları, nedeni, doğrulama komutlarını ve veri/format etkisini belirt.
