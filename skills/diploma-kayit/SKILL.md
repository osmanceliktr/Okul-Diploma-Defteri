---
name: diploma-kayit
description: Maintain the local Node.js and SQLite diploma-record application, including student records, Excel import, PDF generation, and sensitive-data handling.
metadata:
  short-description: Work safely on the diploma records app
---

# Diploma Kayıt Skill

Bu beceri, yerel diploma kayıt uygulamasında kod değişikliği, hata ayıklama ve doğrulama yapılırken kullanılır. Uygulama Node.js, yerleşik `node:sqlite`, statik web dosyaları ve isteğe bağlı `xlsx` paketi kullanır.

## Çalışma sınırı

- Önce `README.md`, `AGENTS.md`, `package.json` ve ilgili kaynak/test dosyalarını oku.
- Mevcut uygulama yapısını koru; gereksiz framework, veritabanı veya dosya formatı geçişi başlatma.
- Diploma kayıtlarını kişisel veri kabul et. Gerçek ad, kimlik numarası, Excel satırı, PDF veya veritabanı içeriğini yanıta, loga ya da yeni dokümana kopyalama.
- Orijinal `.xls` dosyasını yalnızca açıkça istenirse değiştir. Varsayılan olarak içe aktarma ve türetilen çıktılar ayrı tutulur.

## Uygulama değişiklikleri

- Veritabanı şemasını `src/db.js` içinde, içe aktarma davranışını `src/importer.js` içinde, PDF üretimini `src/pdf.js` içinde ve HTTP uçlarını `src/server.js` içinde tut.
- Yeni öğrenci alanlarında hem şema/okuma-yazma akışını hem de arama, içe aktarma ve PDF etkilerini kontrol et.
- Parametreli SQL kullan; kullanıcı girdisini SQL, dosya yolu veya HTML olarak doğrudan birleştirme.
- Dosya yollarını proje içindeki beklenen dizinlerle sınırla. Üretilen PDF'leri `data/exports/` altında tut ve kaynak dosyaları üzerine yazma.
- Türkçe metinleri UTF-8 olarak koru. Alan değerlerini biçimlendirilmiş metin yerine uygun SQLite/spreadsheet değerleri olarak sakla.
- Giriş doğrulamasını hem zorunlu alanlar hem de dosya uzantısı, cilt numarası, kayıt numarası ve tekrar kayıt kuralları için açıkça uygula.

## Excel ve PDF akışları

- Excel aktarımında önce çalışma kitabını incele, uygun sayfayı ve kolon eşlemesini göster, sonra içe aktarımı onayla.
- Şablon sayfasını veri sayfası olarak içe aktarma; sayfa adındaki cilt numarası ile gönderilen cilt numarasını eşleştir.
- Aynı kimlik numarası veya aynı cilt/kayıt numarası ile gelen kayıtları sessizce çoğaltma; kabul ve reddedilen satır sayılarını koru.
- PDF şablon sürümünü değiştirirsen `TEMPLATE_VERSION` değerini güncelle ve çıktı kaydının bunu taşıdığını doğrula.

## Doğrulama

Değişiklikten sonra etkilenen en küçük kapsamı ve ardından genel testleri çalıştır:

```powershell
npm test
```

Gerekirse uygulamayı kontrollü bir test veritabanı veya geçici klasörle başlat. En azından ilgili API/işlev, ilk-orta-son kayıt örnekleri ve hata durumları için kontrol yap. Excel veya görünür PDF değişikliğinde dosyayı Excel/LibreOffice ya da uygun PDF görüntüleyiciyle açıp onarım uyarısı, biçim bozulması, filtre/kolon kaybı ve karakter bozulması olmadığını doğrula.

Sonuç raporunda yalnızca değişen dosyaları, çalıştırılan doğrulamaları ve varsa kalan riski belirt; gerçek kayıt değerlerini paylaşma.
