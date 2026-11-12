# Trendyol Satıcı Paneli — Kurulum ve Kullanım Kılavuzu

Windows için masaüstü uygulaması (Electron). Trendyol'un **resmî V2 Satıcı Entegrasyon API'si** ile çalışır.
Ürün, varyant, stok, fiyat ve sipariş verilerini tek ekranda gösterir. Beden bazında toplu fiyat ve stok güncellemesi yapar.
Otomasyonları ve gelişim/seviye ödül izleyicisini yönetir.

> Uygulamada sahte veya demo veri yoktur. Bütün sayılar Trendyol API'sinden okunur. Erişim yoksa sayı yerine "—" gösterilir.

---

## 1. Kurulum (Windows 10 / 11, 64 bit)

1. Bu klasördeki **`KURULUM.bat`** dosyasına çift tıklayın.
2. Betik aşağıdaki adımları kendisi yapar:
   - Resmî Electron 39.2.7 çalışma zamanını GitHub'dan indirir. Bu yaklaşık 110 MB'tır ve yalnızca ilk kurulumda indirilir.
   - İndirilen dosyanın **SHA-256** özetini doğrular. Özet eşleşmezse kurulum durur.
   - Programı bu klasörün içindeki `program\` klasörüne kurar. Program dosyası `Trendyol Satici Paneli.exe` olarak oluşur.
   - Masaüstüne ve Başlat menüsüne kısayol ekler, ardından uygulamayı açar.
3. **Güncellemek** için `uygulama\` klasörünü yeni sürümle değiştirip `KURULUM.bat`'ı tekrar çalıştırın. Ayarlarınız ve geçmişiniz korunur.
4. Program açılmıyor veya takılırsa **`YENIDEN-BASLAT.bat`** dosyasını çalıştırın. Bu dosya arka planda kalmış kopyaları da kapatıp programı yeniden açar. Açılış adımları ve hatalar bu klasördeki `hata-kaydi.txt` dosyasına yazılır.
5. **Kaldırmak** için `KALDIR.bat` dosyasını çalıştırın. Verileriniz yalnızca "EVET" yazarsanız silinir.

Gereken tek şey ilk kurulumda internet bağlantısıdır. Node.js veya başka bir program kurmanıza gerek yoktur.
Windows SmartScreen "tanınmayan uygulama" uyarısı verirse **Ek bilgi → Yine de çalıştır** seçin. Uyarının nedeni exe'nin kod imzası taşımamasıdır.

## 2. Trendyol API bağlantısı

1. Trendyol Satıcı Paneli'nde **Hesap Bilgilerim → Entegrasyon Bilgileri** sayfasını açın. Bu sayfayı yalnızca yönetici rolündeki ana kullanıcı görebilir.
2. Uygulamada **Ayarlar** sayfasını açın.
3. **Satıcı ID**, **API Key** ve **API Secret** bilgilerini girin. Ortam olarak **Canlı mağaza** seçin.
4. **Test et ve kaydet** düğmesine basın.
   - Bilgiler kaydedilmeden önce salt okunur tek bir istekle bağlantı doğrulanır.
   - İlk kayıttan sonra ürünler otomatik olarak çekilir.

**Güvenlik:**
- Anahtarlar Windows DPAPI (Electron `safeStorage`) ile şifrelenir. Şifreli değer yalnızca bu Windows kullanıcı hesabında çözülebilir.
- Anahtarlar arayüzde, işlem geçmişinde ve dışa aktarılan dosyalarda görünmez.
- Her istek `User-Agent: {SatıcıID} - SelfIntegration` başlığıyla gönderilir. Trendyol bu başlığı zorunlu tutar.

Hata durumları birbirinden ayrı bildirilir: yanlış anahtar (401), yetki/IP reddi (403), istek sınırı (429), ağ hatası ve zaman aşımı.

## 3. Ürün listesi ve beden filtresi

**Ürünler** sayfası Trendyol satıcı panelindeki düzene göre hazırlandı.

**Üst sekmeler:** Tüm, Aktif, Pasif, Onay sürecindeki ve Reddedilen ürünler, her birinin ürün sayısıyla birlikte.

**Alt seçenekler** (Trendyol panelindeki yuvarlak seçim düğmeleri gibi):
- Tüm ürünler: Tükenenler, Fiyat girilmesi gerekenler, Kilitliler, Arşivdekiler, Satışa kapatılanlar
- Aktif ürünler: Buybox dahil olanlar (rakipli), Buybox dahil olmayanlar (tek satıcı), Buybox kaybedilenler, Tükenenler
- Buybox seçeneklerinin sayısı, aktif varyantların buybox bilgisi okunduktan sonra kesinleşir. Bu bilgi seçeneğe tıklayınca otomatik olarak okunur.

**Filtre alanları:**
- Barkod, ürün adı, model kodu ve stok kodu için ayrı kutular
- Kategori, marka, stok durumu ve satış durumu seçimleri
- Beden çipleri ve fiyat aralığı
- **Temizle** düğmesi
- Filtreler yazdığınız anda uygulanır; ayrıca "Filtrele" düğmesine basmanız gerekmez.

**Ürün görünümü (varsayılan):**
- Her satır bir üründür. Satırda şunlar görünür:
  - Görsel ve ad
  - Model kodu (kopyalama düğmesiyle)
  - Renk
  - Varyant sayısı ve bedenler
  - Durum
  - Komisyon
  - Fiyat aralığı (en düşük – en yüksek)
  - Toplam stok
  - **Buybox** durumu
  - Kategori
- **Varyantlar** düğmesine veya oka basınca ürünün bedenleri altta açılır. Her bedenin satırında barkod, stok kodu, fiyat, stok, durum, komisyon ve buybox sırası/fiyatı bulunur. Satırdaki "Fiyat" ve "Stok" düğmeleriyle tek bir varyantı düzenleyebilirsiniz.
- Ürün satırındaki kutu, o ürünün **filtrede kalan** bütün varyantlarını seçer. M filtresi açıksa yalnızca M bedeni seçilir.
- Ürün satırındaki etiket ve kutu simgeleriyle tek bir ürünün fiyatı ve stoğu doğrudan düzenlenebilir.

**Varyant görünümü:** Bütün varyantlar düz bir liste olarak gösterilir.

**Diğer özellikler:**
- **Tabloyu özelleştir:** Sütunları açıp kapatabilirsiniz; seçim hatırlanır.
- Sayfa başına 10, 20, 50 veya 100 ürün gösterilebilir. **Sayfaya git** kutusu ve numaralı sayfa düğmeleri vardır.
- **Excel ile indir:** CSV dosyası oluşturur. Buybox sırası ve fiyatı da dosyaya eklenir.

**Buybox:**
- Bilgi Trendyol'un resmî "Buybox Kontrol" servisinden alınır.
- Yalnızca ekranda görünen sayfa için, 10'arlı gruplar hâlinde sorgulanır ve 30 dakika saklanır.
- **Buybox yenile** düğmesi bilgiyi hemen günceller.
- Buybox'ı kaybettiğiniz varyantlarda buybox fiyatı ve sizin fiyatınızla aradaki fark kırmızı gösterilir.

**Beden filtresi:** Üstteki beden çiplerine (S, M, L, XL, 2XL…) tıklayın.
- Yalnızca **M**'yi seçtiğinizde tabloda yalnızca M varyantları kalır.
- Birden fazla beden seçebilirsiniz, örneğin M ve L.
- Arama, sıralama, sayfalama, seçim ve toplu işlemler yalnızca filtrede kalan varyantlar üzerinde çalışır.
- Her çipin yanındaki sayı, diğer filtreler uygulanmışken o bedende kaç varyant olduğunu gösterir.
- **Bedensiz** çipi, Trendyol'da beden niteliği bulunmayan ürünleri listeler.

**Beden bilgisi nasıl belirlenir:**
- Beden yalnızca Trendyol'daki varyant niteliğinden okunur ("Beden", "Numara" veya "Yaş" alanı).
- Ürün adından beden **tahmin edilmez**. Örneğin adında "M" harfi geçen bir ürün M bedenine atanmaz.
- Farklı yazımlar tek biçime getirilir: `XXL`, `2 XL` ve `2xl` hepsi **2XL** olur; `Medium` **M** olur.

**Seçim:**
- Satıra tıklamak satırı seçer. Shift ile tıklarsanız aralık seçilir. `Ctrl+A` bu sayfadaki satırları seçer.
- Sayfanın tamamını seçtiğinizde **"Filtreye uyan N varyantın tümünü seç"** bağlantısı çıkar. Bütün sonuçları yalnızca bu bağlantıyla seçebilirsiniz.
- Seçim çubuğunda seçili adet, seçili bedenler ve kapsam ("Elle seçilenler" veya "Filtreye uyan tüm sonuçlar") yazar.
- Filtreyi değiştirdiğinizde yeni filtrenin dışında kalan seçimler **otomatik olarak kaldırılır**. Bu yüzden M filtresi açıkken başka bir beden seçimde kalamaz.

**Diğer özellikler:**
- Durum, stok (stokta / düşük / tükenen), kategori ve fiyat aralığı filtreleri
- Ada, bedene, fiyata, stoğa, duruma ve tarihe göre sıralama
- Sayfalama: sayfa başına 25, 50, 100 veya 250 satır
- CSV dışa aktarma (Türkçe Excel ile uyumlu)
- "Onay bekleyen" ve "Reddedilen" sekmeleri. Reddedilen ürünlerde ret nedeni de gösterilir.

**Kısayollar:**
- `/` arama kutusuna gider.
- `Esc` seçimi temizler.
- `F5` senkronizasyonu başlatır.
- `Ctrl+1…9` sayfalar arasında geçiş yapar.

## 4. Toplu fiyat düzenleme

Varyantları seçin ve **Toplu fiyat** düğmesine basın. İşlem üç adımda ilerler.

**1. Kural adımı**
- **Tek kural:** Sabit fiyat, TL ekle, TL düş, % artır veya % azalt.
- **Beden bazlı kurallar:** Örneğin M için %10, L için %5, XL için +20 ₺, 2XL için sabit fiyat.
  - Kurallar yukarıdan aşağıya denenir ve bir varyanta **yalnızca ilk eşleşen kural** uygulanır. Kurallar üst üste binmez.
  - Hiçbir kurala uymayan varyant işlem dışında kalır.
- **Fiyat sonu:** 2 basamak (kuruş), tam sayı, en yakın ,90 veya en yakın ,99.
- **Liste fiyatı:**
  - Koru: liste fiyatı satış fiyatının altında kalırsa satış fiyatına eşitlenir.
  - Aynı kuralı uygula.
  - Satış fiyatına eşitle.
- Hesaplama her varyantın **kendi fiyatına ayrı ayrı** yapılır. Örneğin 250 ₺ + %10 = 275 ₺ olur.

**2. Önizleme adımı**
- Her varyant için ürün, beden, barkod, mevcut fiyat, uygulanan kural, yeni fiyat ve değişim yüzdesi gösterilir.
- **Yeni satış** hücresine yazarak bir varyanta özel fiyat verebilirsiniz.
- Önizleme sırasında şu kontroller yapılır:
  - Sıfır veya negatif fiyat engellenir.
  - Geçersiz sayı reddedilir.
  - Barkodu çakışan varyant işlem dışı bırakılır.
  - Değişmeyen fiyatlar gönderilmez.
  - Ayarlardaki eşiğin (varsayılan %30) üzerindeki değişimler işaretlenir. Uyarılı satır varsa göndermeden önce "kontrol ettim" kutusunu işaretlemeniz gerekir.

**Son onay**
- Ekranda canlı mağaza uyarısı ve işlemin özeti görünür.
- Canlı mağazada 20'den fazla varyant güncelliyorsanız veya uyarılı satır varsa onay kutusuna `ONAYLA` yazmanız gerekir.

**3. Sonuç adımı**
- Kalemler başarılı, başarısız, belirsiz ve işleniyor olarak ayrı ayrı listelenir. Başarısız olanlarda nedeni de yazar.
- Başarı, Trendyol'un toplu işlem sonucuna göre belirlenir. Ardından güncel fiyat Trendyol'dan tekrar okunarak **doğrulanır**.
- **Başarısızları tekrar dene:** Yeni bir işlem oluşturur. Bu işlem de yine onay ister.
- **Eski değerlere dön:** Trendyol'da gerçek bir "geri al" servisi yoktur. Bu düğme eski fiyatları yeni bir güncelleme olarak gönderir.

**Güvenlik mekanizmaları:**
- Plan arayüzde değil, ana süreçte katalog verisiyle **yeniden hesaplanır**.
- İşlem, gönderilmeden önce diske yazılır.
- Gönderimler 1000'erli gruplara bölünür ve Trendyol'un istek sınırlarına uyulur.
- **Aynı işlem iki kez gönderilemez.** Aynı içerik 15 dakika içinde tekrar gönderilemez; bu aynı zamanda Trendyol'un kuralıdır.
- **Aynı barkod iki aktif işte yer alamaz.**
- **Belirsiz sonuçlar otomatik olarak tekrar gönderilmez.** Zaman aşımı, 5xx hatası veya uygulamanın gönderim sırasında kapanması bu duruma girer. "Belirsizleri doğrula" düğmesi Trendyol'daki güncel değeri okur ve kalemi şu şekilde sınıflar:
  - Değer uygulanmışsa başarılı sayılır.
  - Değer uygulanmamışsa güvenle yeniden gönderilebilir.
  - Beklenmeyen bir değer varsa elle kontrol etmeniz istenir.
- Fiyat işleminde yalnızca `salePrice` ve `listPrice` gönderilir. Stok miktarına dokunulmaz.

## 5. Toplu stok, fiyat kuralları, siparişler, raporlar

- **Toplu stok:** Sabit stok, stok ekle veya stok düş. Fiyat işlemindeki önizleme, onay, kalem bazlı sonuç ve geçmiş burada da vardır. Stok 0 ile 20.000 arasında olmalıdır. Yalnızca `quantity` alanı gönderilir.
- **Fiyat kuralları:** Beden bazlı kural setlerini adlandırıp kaydedebilir, açıp kapatabilir, kopyalayabilir ve silebilirsiniz. Kurallar hiçbir zaman otomatik uygulanmaz.
- **Siparişler (V2):**
  - Trendyol paneli düzeninde sekmeler vardır: Tüm Siparişler, Yeni, İşleme Alınanlar, Taşıma Durumunda, Teslim Edilen, İptal/İade ve Askıdaki. Her sekmede paket sayısı yazar.
  - Üst kısımda **Geciken siparişler** (Yeni ve İşleme alınanlar) ile **Bugün kargolanması gereken** sayaçları bulunur. Sayaca tıklayınca liste o siparişlere göre süzülür.
  - Filtre alanları: müşteri adı, sipariş no, paket no, barkod, kargo kodu, tedarik süresi durumu, tarih aralığı ve ürün adı/stok kodu.
  - Arama, durum ve tarih filtresi, detay çekmecesi (ürünler, kargo, paket geçmişi) ve CSV dışa aktarma vardır.
  - Trendyol API'si en fazla son ~1 aylık siparişe erişim verir ve bir sorguda en fazla 2 hafta sorgulanabilir. Uygulama bu aralığı kendisi böler.
  - Gizlilik için adres, telefon, e-posta, TC kimlik ve vergi numarası diske kaydedilmez. Müşteri adı "Ad S." biçiminde saklanır.
- **Raporlar:** Satış ve sipariş özeti, günlük ciro, beden bazında satış, en çok satan varyantlar, stok durumu, fiyat geçmişi, otomasyon raporu ve başarısız işlemler. Hepsi CSV olarak dışa aktarılabilir.

## 5a. Ürün işlemleri, müşteri soruları, iadeler, satıcı paneli

- **Ürün satırı menüsü (⋮):** Detaya git, Fiyat düzenle, Stok düzenle, Ürünü kopyala, Varyant ekle, Arşivle / Arşivden çıkar, Trendyol'da gör.
  - **Detaya git:** Ürün bilgileri, görseller, özellikler ve varyantlar. Başlık ve açıklama düzenlenip Trendyol'a gönderilebilir (onaylı ürünlerde değişiklik Trendyol onayına düşer).
  - **Ürünü kopyala:** Aynı marka, kategori, özellikler, görseller ve açıklamayla yeni bir ürün oluşturur. Yeni model kodu ve her varyant için yeni barkod gerekir; "Boş barkodları model kodundan üret" düğmesi bunları doldurur. Yeni ürün Trendyol onayına girer.
  - **Varyant ekle:** Aynı modele yeni beden ekler (beden listesi Trendyol kategorisinden okunur).
  - **Arşivle:** Ürünün tüm varyantlarını arşive alır; arşivdeki ürün satışa kapanır. Arşivden çıkar ile geri alınabilir.
  - Hepsinde önizleme ve onay vardır; sonuç Trendyol'un toplu işlem kaydından kalem kalem doğrulanır. Aynı içerik 15 dakika içinde tekrar gönderilmez, belirsiz sonuçlar otomatik tekrar gönderilmez.
- **Müşteri soruları:** Cevap bekleyen / cevaplanan / cevapsız kapanan / reddedilen sekmeleri. Cevap (10–2000 karakter) yalnızca siz "Gönder"e bastığınızda gönderilir; hazır şablonlar vardır. Otomasyon merkezinde soruları periyodik çekme görevi vardır (cevap otomatik gönderilmez).
- **İadeler:** Son 30 günün iade talepleri; aksiyon bekleyenler ayrı sekmede. Onay/ret geri alınamaz olduğu için uygulamada yalnızca listelenir; "Satıcı panelinde aç" ile Trendyol'da işlem yaparsınız.
- **Satıcı Paneli sayfası:** Trendyol'un entegrasyon API'si bulunmayan bölümler (kuponlar, indirimler, kampanyalar, reklamlar, performans, değerlendirmeler, ödemeler/fatura/cari, rozetler, mağaza tasarımı, ihlaller…) için kısayollar. Tıklayınca uygulamanın kendi satıcı paneli penceresinde (kendi oturumunuzla) ilgili sayfa açılır.
- **Gelişim ödülleri:** 7 günlük seri kartları da okunur. "Alınabilir" durumdaki günlük kart puan harcamaz (ücretsizdir); otomatik ödül alma açıksa bunlar alınır. Puanla alınan kupon/ödüller her zaman onayınızı ister.

## 5b. Kâr hesaplayıcı, hakediş ve otomatik yenileme

- **Otomatik yenileme:** "Senkronize et" düğmesi kalktı. Ürün, stok ve fiyatlar uygulama açılınca ve her 15 dakikada, siparişler her 5 dakikada, hakediş her 6 saatte kendiliğinden yenilenir. Sağ üstte "Otomatik · 2 dk önce" yazar; hemen yenilemek için yanındaki ↻ düğmesine (veya F5) basın. Aralıklar Otomasyonlar sayfasından değiştirilebilir. Bu görevler yalnızca okuma yapar ve internet kesilse bile kendini kapatmaz, bekleyip tekrar dener.
- **Kâr Hesaplayıcı:** Her model için alış maliyetini (KDV dahil) ve desiyi girersiniz; farklı bedene ayrı maliyet verilebilir. Çok ürün için "Maliyet şablonu"nu indirip Excel'de doldurun ve "Maliyetleri yükle" ile geri yükleyin (CSV, Türkçe Excel'in ; ayracı desteklenir).
  - Komisyon oranı Trendyol'dan gelir; panelde yazdığı gibi **KDV dahil** hesaplanır ("KDV Dahil Komisyon Oranı").
  - Kargo ücretleri **Trendyol satıcı panelinin resmi listesinden** gelir: "Kargo İşlemleri › Kargo Fiyatları & Desi › Güncel Kargo Fiyatları" (5 Ekim 2026, KDV hariç, 9 firma, 0–100 desi). Barem: Trendyol Akademi "Kargo Barem Altı Uygulaması" (10 Ağustos 2026): 0–199,99 ₺ ve 200–349,99 ₺ siparişlerde, en fazla 10 desi.
  - **24 saatte kargolama indirimi:** Termini 1 gün (veya Bugün Kargoda / Hızlı Teslimat) olup zamanında kargolanan siparişlerde barem daha ucuzdur (TEX: 38,74 ₺ / 70,41 ₺; standart: 73,33 ₺ / 78,74 ₺). Uygulama bunu ürünün Trendyol'daki termin süresine göre otomatik seçer; ayardan "hep hızlı / hep standart" yapılabilir.
  - "Ücret ayarları › Panelden güncelle" düğmesi, Trendyol listeyi değiştirdiğinde yeni PDF'i satıcı panelinizden okuyup fiyatları günceller (satıcı paneli penceresinde bir kez giriş yapmış olmanız gerekir; panelde hiçbir ayar değişmez).
  - Platform hizmet bedeli varsayılanı faturalarınızdaki tutardır: gönderi başı 10,99 ₺ + KDV. Stopaj %1. Kendi kargo anlaşmanız varsa fiyatları elle girebilirsiniz.
  - Her ürün için net kâr, marj, Trendyol'un hesabınıza yatıracağı tutar, başabaş fiyatı ve hedef marj fiyatı gösterilir. Zarar edenler ve düşük marjlılar ayrı sekmededir. "Hızlı hesap" ile listede olmayan bir ürünü de hesaplayabilirsiniz. Son 30 günün siparişlerinden gerçekleşen kâr da hesaplanır.
  - **Zarar kilidi:** Toplu fiyat düzenlemede varsayılan olarak açıktır. Maliyeti girilmiş bir ürünü zarar ettirecek fiyat gönderilmez (kontrol ana süreçte yapılır). Önizlemede her satırın birim kârı görünür.
- **Hakediş:**
  - **Ay içinde hesabınıza yatan + yatacak toplam:** Yapılan ödemeler cari hesap ekstresinden ("Ödeme" kayıtları), yatacak tutarlar ve günleri **satıcı panelindeki Ödemeler ekranından** (Trendyol'un kendi takvimi) okunur. Bölgeler panelle aynıdır: Türkiye & Körfez (pazartesi/perşembe), Avrupa (ayda bir), Azerbaycan. Trendyol'daki toplam bakiye ve erken ödemeyle alınabilecek tutar da gösterilir. Panel okunamazsa vade tarihine göre tahmin gösterilir ve bu açıkça yazılır.
  - **Hareketler ve kesintiler:** Ay içindeki brüt satış, iade, komisyon, indirim/kupon, kargo faturaları, platform hizmet bedeli, uluslararası hizmet bedeli, yurt dışı iade bedeli, ceza/tazmin, stopaj; bölgelere göre ve satışa oranıyla. Komisyon faturası (bilgilendirme) çift sayılmaz.
  - Gerçek mağaza verisiyle doğrulandı (Ekim 2026): yatan 22.046,81 ₺ + yatacak 28.324,47 ₺ = 50.371,28 ₺; panelle birebir aynı.

## 6. Otomasyon merkezi

| Otomasyon | Varsayılan | Ne yapar |
|---|---|---|
| Ürün, stok ve fiyat senkronizasyonu | 60 dk, açık | Yalnızca okur |
| Sipariş senkronizasyonu | 15 dk, açık | Yalnızca okur; yeni siparişleri bildirir |
| Bekleyen toplu işlem kontrolü | 2 dk, açık | Gönderilmiş fiyat/stok işlemlerinin sonucunu okur |
| Düşük stok uyarısı | 60 dk, açık | Eşiğin altına düşen varyantları bildirir |
| Gelişim / seviye ödül izleyici | 60 dk, **kapalı** | Bölüm 7'ye bakın |

- Her otomasyon için açma/kapatma, çalışma sıklığı ve "Şimdi çalıştır" düğmesi bulunur. Son ve sonraki çalışma zamanı, sonuç, başarılı ve hatalı sayısı ile hata mesajı da gösterilir.
- Aynı otomasyon aynı anda iki kez çalışamaz.
- Art arda 3 hata alan otomasyon kendini duraklatır.
- **Tümünü duraklat** düğmesi bütün otomasyonları durdurur.

**Uygulama kapanınca ne olur?**
- "Arka planda çalış" ayarı açıksa (varsayılan) pencereyi kapattığınızda uygulama sistem tepsisinde çalışmaya devam eder.
- Tamamen kapatmak için tepsideki simgeye sağ tıklayıp **Çıkış** seçin.
- "Windows açılışında başlat" ayarı açılırsa uygulama bilgisayar açıldığında gizli olarak başlar.
- Bilgisayar kapalıyken veya uygulamadan çıkıldığında otomasyonlar **çalışmaz**.

Fiyat değiştiren zamanlanmış bir otomasyon bilinçli olarak eklenmedi. Fiyat değişiklikleri her zaman önizleme ve onayla yapılır.

## 6b. Grup otomasyonu (hedefe ulaşınca kapat) — bilgisayar ve telefon

Seçtiğiniz ürün ve bedenlerin **toplam satışı** hedefe ulaşınca hepsinin stoku **0** yapılır. Önceki stok saklanır, "Yeniden aç" ile geri yüklenir.

- **Nerede çalışır?** Kendi Cloudflare hesabınızdaki ortak sunucuda (`modafloww-sunucu.modafloww.workers.dev`), **her dakika**. Bilgisayar ve telefon kapalıyken de çalışır. Bilgisayar ve telefon aynı kuralları, sayaçları ve geçmişi görür; ikisi de sunucuya bağlanır.
- **Tek yürütücü sunucudur.** Cihazlar ürün stoğunu bu otomasyon için doğrudan değiştirmez. Çevrimdışı bir cihaz eski veriyle hiçbir şey yapamaz; işlem düğmeleri kapanır.
- **Sayım:** Trendyol siparişleri okunur. Her sipariş satırı (paket no + satır no) bir kez sayılır. İki cihaz açık olsa veya sunucu aynı siparişi tekrar okusa da sayı değişmez. İptal edilen satır sayımdan düşer. Sayım, kuralın etkinleştirildiği andan (veya seçtiğiniz tarihten, en fazla 30 gün geriye) başlar.
- **Kapatma:** Hedefe ulaşınca sunucu kuralı kilitler, stokları **o an Trendyol'dan** okuyup saklar ve tek istekle 0 yapar. Sonuç toplu işlem kaydından okunur. Aynı anda birden çok kontrol gelse de yalnızca bir kez gönderilir.
- **Yeniden açma:** elle (önizleme + onay) veya kapandıktan N saat sonra otomatik. Bu arada stoğunu elle değiştirdiğiniz bedenlere dokunulmaz. Açılan kural pasife döner; tekrar etkinleştirince sayım sıfırdan başlar.
- **Güvenlik:**
  - Yeni kural **pasif** oluşur.
  - Etkinleştirmek için son 15 dakika içinde, kuralın o hâli için **simülasyon** ve açık onay gerekir. Simülasyon gerçek değişiklik yapmaz: güncel satış, kalan, kapanacak stok ve uyarılar gösterilir.
  - Aynı ürün iki etkin kuralda olamaz.
  - Kural iki cihazda aynı anda değiştirilirse ikinci değişiklik reddedilir ve güncel hâl yüklenir (sürüm kontrolü).
  - Sonucu belirsiz kalan istek (zaman aşımı, Trendyol 5xx) **otomatik tekrar gönderilmez**. "Kontrol et" Trendyol'daki gerçek stoğa bakar.
  - Trendyol'a ulaşılamazsa hiçbir şey değişmez; hata ortak geçmişe bir kez yazılır.
- **Ortak geçmiş:** kural oluşturma/düzenleme, simülasyon, etkinleştirme, kapatma (kalem kalem başarılı/başarısız), yeniden açma, doğrulama ve sunucu hataları; kim yaptı (cihaz adı) ve ne zaman.
- **Bağlantı:**
  - Bilgisayar: Grup otomasyonu › Bu bilgisayarı bağla (kurulum kodu, bir kez). Bu sırada bilgisayardaki Trendyol API bilgileri sunucuya şifreli gönderilir. Sunucuda AES-GCM ile saklanır; hiçbir ekranda ve geçmişte görünmez.
  - Telefon: bilgisayarda Cihazlar › Eşleme kodu üret. Kod 8 hanelidir, 10 dakika geçerlidir ve tek kullanımlıktır. Telefonda Diğer › Grup otomasyonu'na girilir.
  - Cihaz erişimi istenince kaldırılabilir.
- **Sınırlar:**
  - Cloudflare ücretsiz planı dakikada bir çalıştırma ve günlük istek sınırlarıyla bu iş için yeterlidir.
  - Trendyol API'sinde panelin "satışa kapat" düğmesinin karşılığı olmadığı için kapatma stok 0 ile yapılır.

## 6c. Görünüm ve kişiselleştirme — bilgisayar ve telefon

- **Tema:** Açık, Koyu, Sistemle aynı.
- **Hazır kombinasyonlar:** Charcoal & Ivory (varsayılan), Midnight Blue, Graphite & Purple, Slate & Teal, Forest, Monochrome. Her birinin açık ve koyu hâli vardır. Seçtikten sonra renkler tek tek düzenlenebilir.
- **Alan alan renk** (açık ve koyu tema için ayrı ayrı):
  - Ana vurgu, yan menü / navigasyon (telefonda alt sekme çubuğu), üst çubuk, sayfa arka planı, kart ve panel
  - Birincil ve ikincil buton, aktif menü ve seçili filtre, bağlantı/ikon, kenarlık
  - Seçim alanı/sekme zemini, üç grafik serisi
  - Durum renkleri (başarı, uyarı, hata)
- **Renk seçimi:** paletten ya da HEX koduyla seçilir. Geçersiz kod kaydedilmez. Bir alanı değiştirmek diğerlerini değiştirmez.
- **Okunabilirlik:**
  - Metin rengi zemine göre otomatik seçilir (açık zeminde koyu, koyu zeminde açık).
  - Sayfa zemini ile kart zemini farklı tonda seçilse bile her yüzeydeki metin kendi zeminine göre okunur.
  - Kontrastı yetersiz seçimler uyarı verir; "Öneriyi uygula" düğmesi uygun tonu yerleştirir.
  - Durum renkleri anlamını kaybedecek bir tona çekilirse uyarılır (kırmızı hata, yeşil başarı, turuncu uyarı varsayılan olarak korunur).
- **Önizleme ve kaydetme:**
  - Değişiklik bütün uygulamada anında önizlenir.
  - Kaydet / İptal (geri alır) / Varsayılan tasarıma dön.
  - Renk kombinasyonu adıyla kaydedilip tekrar uygulanabilir. Ortak sunucuya bağlıysanız kayıtlı paletler bilgisayar ve telefon arasında eşitlenir. Tema seçimi her cihazda ayrı kalır.
- Ayarlar uygulama kapatılıp açıldığında korunur. Varsayılan tasarım değişmez: `#3D3F45`, `#F5F3EE`, `#FFFFFF`, `#E7E5E0`.

## 5c. Sipariş satırları ve kargo etiketi

- Siparişler sayfası Trendyol satıcı panelindeki düzende: sipariş no (kopyala), sipariş tarihi, paket no, durum, **kalan süre** (bugün bitiyorsa amber, geçtiyse kırmızı), alıcı, ürün görseli ve adet rozeti, stok kodu / renk / barkod / beden, birim fiyat, kargo firması, takip no, desi, satış tutarı ve **fatura durumu** (fatura bekleniyor / faturayı gör).
- **Kargo etiketi A4** ve **Etiket sticker** düğmeleri etiketi **panel sayfasını açmadan** yazdırır. Uygulama, sizin giriş yaptığınız satıcı paneli oturumunu görünmez bir pencerede kullanır: paneldeki "Kargo Etiketini … Yazdır" işlemini o sipariş için çalıştırır, panelin hazırladığı etiketi yakalar ve yazıcıya (veya PDF'e) gönderir. Etiket Trendyol'un kendi etiketidir; uygulama etiket çizmez.
- Panelde düğmeye basınca olduğu gibi Trendyol paketi **"etiket yazdırıldı"** olarak işaretler. Sipariş durumu değişmez, kargoya verilmez, fatura işlemi yapılmaz. İlk kullanımda bu yazan bir onay penceresi çıkar; onay verilmeden hiçbir şey yapılmaz (Ayarlar'dan yeniden sorması sağlanabilir).
- **Ayarlar › Kargo etiketi**: çıktı (yazıcı / PDF), A4 yazıcısı ve sticker (termal) yazıcısı. Yazıcı seçilirse sormadan o yazıcıya gider; "Her seferinde sor" seçiliyse Windows yazdırma penceresi açılır. PDF seçilirse etiket İndirilenler › Trendyol Etiketleri klasörüne kaydedilip açılır. Seçili yazıcı bulunamazsa panelde hiçbir işlem yapılmadan durur.
- Panel ek bir karar isterse uygulama **hiçbir şey seçmez**, paneli o siparişle açar ve düğmeyi vurgular: A4 etiket tercihi (ürün bilgili / bilgisiz — panelde bir kez seçilir), desi/koli uyarısı, birden çok pakete bölünmüş sipariş. Kargoya verilmiş siparişte "etiket düğmesi yok" uyarısı çıkar. Panele giriş yapılmamışsa giriş istenir (giriş, CAPTCHA ve 2FA'yı siz yaparsınız).
- Her etiket denemesi İşlem geçmişine "Kargo etiketi" türüyle yazılır. "Panelde aç" düğmesi siparişi eskisi gibi panelde gösterir.
- "Fatura işlemleri" bağlantısı da siparişi panelde açıp "Fatura İşlemleri" düğmesini gösterir. Kargoya verilmiş siparişlerde "Kargo takip" bağlantısı çıkar.

## 6a. Yeni sipariş bildirimi

- Uygulama açıkken (veya sistem tepsisinde) **her 30 saniyede** Trendyol'a tek bir okuma isteğiyle yeni sipariş olup olmadığını sorar (son 2 gün, "Yeni" durumundaki paketler).
- Yeni sipariş gelince ekranın sağ altında koyu gri bir **bildirim kartı** çıkar: tutar, sipariş numarası, ürün adedi, ürün ve beden; hızlı teslimat / yurt dışı ise etiketi. Kısa bir uyarı sesi çalar. Kart 20 saniye sonra kendiliğinden kapanır; aynı anda en fazla 3 kart görünür, fazlası "N yeni sipariş daha" kartında toplanır.
- **Siparişi görüntüle** uygulamayı öne getirir ve o siparişin ayrıntısını açar. Müşteri adı, adres, telefon kartta gösterilmez.
- Aynı sipariş ikinci kez bildirilmez. İlk açılışta zaten bekleyen siparişler için bildirim çıkmaz (yalnızca o andan sonra gelenler).
- **Ayarlar › Sipariş bildirimleri:** aç/kapat, kontrol sıklığı (20 sn – 2 dk), masaüstü kartı, sesli uyarı ve "Örnek bildirim göster". Otomasyonlar sayfasında da "Yeni sipariş bildirimi" satırı olarak görünür.
- Dakikada 2 istek, Trendyol'un sipariş servisi sınırının (dakikada 25) çok altındadır. Bilgisayar kapalıyken veya uygulamadan çıkıldığında bildirim gelmez.

## 7. Otomatik gelişim ve seviye ödülleri

**Gerçek durum:** Trendyol'un resmî geliştirici dokümantasyonunda gelişim, seviye veya ödül mağazası için bir API **yok** (Ekim 2026 itibarıyla). Bu yüzden bu modül tarayıcı otomasyonuyla çalışır.

**Kurulum:**
1. **Satıcı panelini aç** düğmesine basın. Uygulamaya özel bir pencerede `partner.trendyol.com` açılır.
2. Giriş yapın. Giriş, CAPTCHA ve iki adımlı doğrulamayı **siz** yaparsınız; uygulama bunları atlatmaya çalışmaz. Oturum bu bilgisayarda saklanır.
3. Panel penceresinde gelişim/seviye ödül sayfasına gidin ve **Açık sayfayı kullan** düğmesine basın.
4. **Şimdi kontrol et** düğmesine basın.
   - Sayfa arka planda açılır.
   - "Hemen Al", "Talep Et" gibi butonları olan kartlar okunur ve sınıflandırılır: ücretsiz, harcama gerektiren, ek şartlı, alınmış, uygun değil.
   - Sayfadaki seviye, puan ve hedef satırları ayrıca gösterilir.

**Otomatik talep** varsayılan olarak **kapalıdır**. Açarsanız şu kurallar geçerlidir:
- Yalnızca **ücretsiz** ödüller talep edilir. Varsayılan ayarda kartta "ücretsiz" ibaresinin bulunması gerekir.
- Puan, jeton, para veya hak harcayan ödüller ve şartlı ödüller **asla otomatik alınmaz**. Bunları elle talep ederseniz `ONAYLA` yazmanız istenir.
- Bir ödül için en fazla **bir** otomatik deneme yapılır. Deneme kaydı tıklamadan **önce** diske yazılır.
- Tıklamadan sonra sayfa yeniden okunur ve sonuç doğrulanır.
  - Sonuç belirsizse aynı ödül tekrar denenmez ve **otomasyon kendini durdurur**.
  - Oturum kapanırsa veya sayfa yapısı değişirse (daha önce bulunan kartlar artık bulunamıyorsa) otomasyon durur ve bildirim gönderir.

**Önemli kısıtlar:**
- Ödül sayfasının gerçek HTML yapısını göremediğim için algoritma **sentetik bir test sayfasıyla** doğrulandı (bkz. Test sonuçları).
- İlk kullanımda "Şimdi kontrol et" ile kartların doğru okunup okunmadığını kontrol edin. Butonların metni farklıysa sağdaki ayardan ekleyin.
- Satıcı paneli üzerinde otomatik işlem yapmanın Trendyol kullanım koşullarına uygun olup olmadığını kontrol etmek sizin sorumluluğunuzdadır.

## 8. İşlem geçmişi ve güvenlik

- **İşlem Geçmişi → Toplu işler:** Her toplu fiyat ve stok işlemi kalem bazında saklanır. Kayıtta filtre kapsamı, eski ve yeni değer, durum, neden ve batch kimliği bulunur. Bu ekrandan doğrulama, tekrar deneme ve eski değere dönüş yapılabilir.
- **İşlem Geçmişi → Denetim kaydı:**
  - Fiyat, stok, ödül, senkronizasyon, otomasyon ve güvenlik olayları kaydedilir. Tür, durum ve metin ile filtrelenebilir; CSV olarak dışa aktarılabilir.
  - En fazla 50.000 kayıt tutulur.
  - Kayıtlara gizli anahtar, çerez veya erişim belirteci yazılmaz.
- **Uygulama kilidi (PIN):** Ayarlar sayfasından açılır. Kilitliyken arayüz hiçbir işlem çağıramaz. Hatalı PIN girişleri kaydedilir.
- **Veriler:** `%APPDATA%\Trendyol Satici Paneli\veri\` klasöründe JSON dosyaları olarak tutulur.
  - Yazma işlemi atomiktir: dosya önce geçici olarak yazılır, sonra yeniden adlandırılır. Bozuk bir dosya bulunursa yedeklenir ve uygulama çalışmaya devam eder.

## 9. Test sonuçları (geliştirme ortamında gerçekten çalıştırıldı)

`node --test` ile **77 otomatik testin 77'si geçti** (3 yeni sipariş bildirimi testi dahil): 24 birim, 18 entegrasyon, 9 kâr hesabı (gerçek bir siparişin panel dökümüyle birebir), 3 kargo listesi (PDF okuyucu), 5 hakediş (gerçek API etiketleri, panel Ödemeler ekranı), 6 ürün işlemi (kopyala / varyant ekle / arşivle / içerik), 6 servis (zarar kilidi dahil), 3 ödül sayfası (Chromium) testi. Ayrıca uygulama sahte Trendyol API'sine karşı açılıp ürün menüsü, kopyalama, varyant ekleme, arşivleme, müşteri soruları, iadeler ve satıcı paneli sayfaları ekran görüntüsüyle kontrol edildi; sayfa hatası yok. Kargo etiketi yazdırma, paneli taklit eden yerel sahte sayfayla (`scripts/label-check.cjs`) denendi: onaysız istek reddedildi; A4 ve sticker etiket PDF'e doğru metin ve barkodla çıktı, görünür pencere açılmadı, sahte panel paketi doğru türde "yazdırıldı" işaretledi; A4 seçeneği / bölünmüş paket durumunda hiçbir şey seçilmeden panel açıldı; kargodaki siparişte ve olmayan yazıcıda anlaşılır hata verildi ve hiçbir işaretleme yapılmadı. Gerçek mağazada etiket yazdırılmadı; gerçek panelde yalnızca düğme bulma mantığı okuma amaçlı doğrulandı. Tasarım yenilemesinden sonra bütün testler ve uçtan uca akış (M filtresi → %10 → önizleme → ONAYLA → sonuç; Trendyol'a 200 kalem, hepsi M, stok alanı yok) 1440×900 ve 1920×1080 ekranda yeniden çalıştırıldı.

**Beden:**
- Normalizasyon doğru çalışıyor.
- Ürün adındaki "M" harfi bedene atanmıyor.
- İçerik düzeyindeki beden yalnızca tek varyantlı ürünlerde kullanılıyor.

**Filtre:**
- M filtresi 1001 varyant içinden yalnızca 200 M varyantını gösteriyor.
- M + L birlikte seçildiğinde 400 varyant gösteriliyor.
- Arama ve barkod araması beden filtresiyle sınırlı kalıyor.
- Stok, durum, fiyat ve sıralama filtreleri doğru çalışıyor.

**Fiyat:**
- 250 ₺ + %10 = 275 ₺ hesaplanıyor; her varyant kendi fiyatıyla hesaplanıyor.
- Sabit fiyat, TL ekle/düş ve yüzde artış/indirim doğru sonuç veriyor.
- Fiyat sonları (,90 / ,99 / tam sayı) doğru uygulanıyor.
- Sıfır, negatif ve geçersiz değerler reddediliyor.
- Beden kurallarında ilk eşleşen kural uygulanıyor, kurallar üst üste binmiyor.
- Liste fiyatı modları doğru çalışıyor.
- Olağandışı değişim uyarısı ve özel fiyat çalışıyor.

**Gönderim** (sahte Trendyol sunucusuyla):
- M filtresiyle seçilen 50 varyant gönderildiğinde yalnızca bu 50 barkod Trendyol'a gidiyor; diğer bedenler değişmiyor.
- İstekte stok alanı gönderilmiyor.
- Kısmi başarısızlık kalem bazında raporlanıyor.
- Aynı anda iki tıklamada yalnızca bir istek gidiyor.
- Aynı içerik 15 dakika içinde tekrar gönderilemiyor.
- Zaman aşımında istek tekrar gönderilmiyor ve kalem "belirsiz" oluyor; doğrulama sonrası güvenle gönderilebiliyor.
- 429 alındığında güvenli tekrar deneme yapılıyor.
- 5xx sonucu "belirsiz" sayılıyor.
- Uygulamanın gönderim sırasında kapanması kurtarılıyor.
- 1001 kalem 1000 + 1 olarak bölünüyor.
- Geri alma ve stok işlemi doğru çalışıyor.

**Güvenlik:**
- API anahtarları diskte düz metin olarak bulunmuyor.
- Yanlış anahtar kaydedilmiyor.
- PIN kilidiyle bütün işlemler engelleniyor.
- Denetim kaydında gizli bilgi yok.
- Siparişlerde kişisel veriler diske yazılmıyor.
- CSV formül enjeksiyonu engelleniyor.

**Otomasyon:**
- Eşzamanlı çalışma engelleniyor.
- Duraklatılan otomasyon yeni iş başlatmıyor.
- Art arda hatada otomasyon duraklıyor.

**Ödül:**
- Kartlar doğru sınıflandırılıyor.
- Harcamalı ve şartlı ödüller asla seçilmiyor.
- Daha önce denenmiş ödül tekrar denenmiyor.
- Pasif butona tıklanmıyor.
- Giriş sayfası "oturum kapalı" olarak algılanıyor.
- Kartların kaybolması "yapı değişikliği" olarak algılanıyor.

**Uçtan uca kontroller (gerçek Electron penceresi, sahte API):**
- Ayarlar → senkronizasyon → M filtresi → tümünü seç → %10 → önizleme → `ONAYLA` → sonuç akışı tamamlandı. Trendyol'a **200 kalem gitti, hepsi M bedeniydi, stok alanı gönderilmedi**.
- Ödül izleyici sentetik sayfada ücretsiz ödülü 1 kez aldı ve harcamalı ödüle hiç tıklamadı.
- Tıklamanın sonuçsuz kaldığı senaryoda sonuç "belirsiz" oldu, otomasyon kendini durdurdu ve aynı ödüle ikinci kez tıklanmadı.

**Test edilemeyenler:**
- **Gerçek Trendyol hesabınızla hiçbir istek yapılmadı.** Bu ortamdan Trendyol'a erişim yoktu; ayrıca izniniz olmadan canlı mağazada değişiklik yapılmaz.
- **Gerçek ödül sayfası** test edilemedi.
- **Windows kurulum betiği** Windows'ta çalıştırılarak test edilemedi.

İlk kullanımda önerilen sıra:
1. Bağlantıyı test edin.
2. Senkronizasyon yapın.
3. Tek bir varyantta küçük bir fiyat değişikliği deneyin.
4. Ödül sayfasında "Şimdi kontrol et" ile kartların doğru okunduğunu kontrol edin.

### Ekim 2026 — grup otomasyonu, ortak sunucu ve görünüm testleri (gerçekten çalıştırıldı)

- **Birim testleri** (`npm test` + `test/group-auto.test.js`, `test/theme.test.js`): 93 test geçti.
- **Ortak sunucu** (`server/test/server.test.mjs`): gerçek Worker paketi, Miniflare + yerel D1 + sahte Trendyol ile 10 senaryo geçti:
  - Eşleme: hatalı kod, tek kullanımlık kod, ana cihaz varken kurulum kodunun reddi.
  - Şifreli bilgi saklama.
  - Pasif oluşturma, simülasyon ve onay zorunluluğu.
  - Sürüm çakışması.
  - Çift sayım ve iptal düşme.
  - Çakışan kural.
  - Hedefe ulaşınca tek gönderim (eşzamanlı 3 çalıştırmada bile).
  - Yeniden açmada elle değişen stoğa dokunmama.
  - Bağlantı kesintisi ve belirsiz sonucun tekrar gönderilmemesi.
  - Otomatik yeniden açma ve cihaz erişiminin kaldırılması.
- **Bilgisayar arayüzü** (`scripts/groupauto-check.cjs`, Electron, 1440×900 ve 1920×1080, açık ve koyu): bağlanma, ürün/beden seçimi, simülasyon, etkinleştirme, sayım, kapatma (yalnızca seçili bedenler), ayrıntı, ortak geçmiş, eşleme kodu, yeniden açma ve çevrimdışı sunucu (düğmeler kapanır, hiçbir şey gönderilmez) çalıştı.
- **Telefon arayüzü** (`mobile/scripts/groupauto-check.cjs`, 390×844, açık ve koyu):
  - Telefonda oluşturulan kural bilgisayar tarafında aynı görünüyor.
  - Bilgisayarda değişen kuralı telefon eski sürümle değiştiremiyor.
  - Simülasyon, etkinleştirme, kapatma, ayrıntı, geçmiş, yeniden açma ve çevrimdışı durumda yatay taşma yok.
- **Görünüm** (`scripts/theme-check.cjs`, `mobile/scripts/theme-check.cjs`):
  - Bütün ana sayfalar açık, koyu, bir hazır tema ve özel bir kombinasyonla (koyu sayfa zemini + beyaz kartlar + sarı buton) açıldı.
  - Görünen her metnin zeminine karşı kontrastı ölçüldü; bulunan düşük kontrastlar düzeltildi ve tekrar çalıştırıldığında sorun kalmadı.
  - Geçersiz HEX, canlı önizleme, iptal, palet kaydetme, yeniden açılışta kalıcılık ve varsayılana dönüş denendi.
- **Gerçek cihazda denenmedi:** Android APK'nın telefonda kurulumu ve PC paketinin Windows'ta kurulumu sizin cihazlarınızda yapılacak. Derleme ve paketleme burada yapıldı, kurulum ve açılış testi yapılmadı.

## 10. Kısıtlar ve gelecekte yapılabilecekler

- Sipariş durumu değiştirme, kargo bildirimi, fatura ve iade onayı gibi geri alınamaz sipariş işlemleri bu sürümde yok. Trendyol API'si bunları destekliyor ve sonraki sürüme eklenebilir.
- Satış metrikleri yalnızca API'nin verdiği son ~1 aylık sipariş verisinden hesaplanıyor. Maliyet ve kâr verisi API'de bulunmuyor.
- Trendyol V1 servisleri 15 Ekim 2026'da kapatıldı. Uygulama yalnızca V2 uç noktalarını kullanıyor.
- Exe kod imzası taşımadığı için Windows SmartScreen uyarı gösterebilir.
- İade onay/ret ve kupon/kampanya/reklam yönetimi uygulama içinde işlenmez; Satıcı Paneli kısayollarıyla Trendyol'da açılır.
- Kopyalanan ürünün desisi API'den okunamadığı için kopyalama ekranında elle kontrol edilmelidir.

---

## 10a. Arayüz ve tasarım sistemi (Ekim 2026)

- **Palet:** yan menü ve üst çubuk koyu gri `#3D3F45`, içerik zemini kırık beyaz `#F5F3EE`, kartlar ve tablolar beyaz `#FFFFFF`, ayırıcılar `#E7E5E0`, ana metin `#242529`, ikincil metin `#73757C`. Bütün renkler `src/renderer/styles.css` başındaki değişkenlerden gelir.
- **Durum renkleri:** kırmızı = hata / başarısız / kritik, yeşil = başarılı / tamamlandı, amber = uyarı / bekleyen önemli işlem, gri = nötr bilgi. Rozetler, bildirimler ve uyarılar her zaman açık zemin + nokta veya ikon + metinle gösterilir; renk tek başına anlam taşımaz. Sıfır olan sayılar renklendirilmez (ör. "0 başarısız" kırmızı görünmez).
- **Vurgu:** aktif menü öğesi, seçili beden çipi, birincil düğme ve varyant seçildiğinde beliren seçim çubuğu koyu gri dolguludur. Seçim çubuğu kaç varyantın, hangi bedenlerin ve hangi kapsamın (elle / filtrenin tamamı) seçildiğini gösterir.
- **Tipografi:** Geist, tek ölçek (11 / 12 / 13 / 15 / 20 / 28 px), bütün sayılar hizalı rakamla; büyük harfli etiketler kaldırıldı.
- **Sayfa düzeni:** her sayfa aynı başlık satırıyla başlar (başlık, kaynak/güncellik bilgisi, işlemler). Üst çubukta her sayfadan çalışan ürün araması vardır (`Ctrl+K`).
- **Ürün tablosu** 1440 px ekranda yatay kaydırma olmadan sığar; varyant sayısı ürün bilgisinin altına taşındı (ayrı sütun "Sütunlar" menüsünden açılabilir). Toplu fiyat önizlemesinde mevcut fiyat → yeni fiyat yan yana gösterilir.
- Tarih kutuları Türkçe (gg.aa.yyyy) gösterilir.
- **Koyu tema:** Ayarlar › Görünüm'den Açık / Koyu / Windows ile aynı seçilir; üst çubuktaki ay/güneş düğmesi tek tıkla değiştirir. Koyu temada zemin saf siyah değil koyu gri (#26272C), metin kırık beyazdır; durum renkleri (kırmızı/yeşil/amber) aynı anlamı korur. Pencere başlık çubuğu da temaya uyar.
- **Geri dönüş:** tasarım öncesi sürüm `yedek\2026-10-17-tasarim-oncesi\` klasöründe. Oradaki `GERI-AL.bat` eski dosyaları geri koyar; ardından `KURULUM.bat` çalıştırılır.

## Geliştirici notları

```
kaynak/
  core/        Saf iş mantığı (Node.js, bağımlılıksız): API istemcisi, beden, fiyat, filtre, toplu işler, sipariş, zamanlayıcı, denetim, CSV, ödül motoru
  electron/    Ana süreç: pencere, tepsi, IPC servisleri, şifreleme, ödül izleyici
  src/renderer React arayüzü (esbuild ile tek dosyaya derlenir)
  test/        node:test testleri + yalnızca test için sahte Trendyol sunucusu
  scripts/     build-ui.mjs, package-win.mjs, ui-check.cjs, reward-check.cjs
  windows/     KURULUM.bat / kurulum.ps1 / KALDIR.bat / kaldir.ps1
```

Komutlar (Node 20+):
- `npm install` — bağımlılıkları kurar
- `npm test` — testleri çalıştırır
- `npm start` — uygulamayı geliştirme modunda açar
- `npm run paketle` — `release/trendyol-panel` teslim klasörünü oluşturur

API kimlik bilgileri ortam değişkeninde **tutulmaz**; şifreli olarak Ayarlar ekranından girilir. Ortam değişkenleri yalnızca geliştirme içindir; `.env.example` dosyasına bakın.
