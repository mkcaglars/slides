# Slide: öğretmen kontrollü eş zamanlı sunum

`slide.mkcaglar.com` için: öğretmen bir sunumu başlatır, izleyiciler (hesap gerekmeden) ekrandaki 6 haneli kodu girerek sunumu kendi cihazlarında canlı izler. Slaytları **sadece öğretmen** değiştirir; izleyicilerde ileri/geri gibi hiçbir kontrol yoktur.

## Kurulum ve çalıştırma

```bash
npm install
TEACHER_PASSWORD=gizliSifre npm start     # varsayılan port 3000 (PORT ile değiştirilebilir)
```

| Sayfa | Adres |
|---|---|
| İzleyici (kod girme) | `https://slide.mkcaglar.com/` |
| İzleyici (kod bağlantıda) | `https://slide.mkcaglar.com/?kod=123456` |
| Öğretmen paneli | `https://slide.mkcaglar.com/ogretmen` |

## Nasıl çalışır?

**Öğretmen**
1. `/ogretmen` adresinden şifreyle girer (giriş 30 gün hatırlanır).
2. PowerPoint sunumunu **PDF olarak kaydeder** (*Dosya → Farklı Kaydet → PDF*) ve dersten önce yükler. Slaytlar öğretmenin tarayıcısında resme çevrilip sunucuya yüklenir; ilerleme çubuğu gösterilir.
3. **▶ Başlat** ile sunum başlar ve 6 haneli kod üretilir. Projeksiyonda kod, adres ve QR kodun büyük gösterildiği **Katılım ekranı** açılır.
4. Sunucu ekranında o anki slayt, sonraki slayt önizlemesi, küçük resim şeridi, izleyici sayısı ve kod görünür.
   - İleri: `→` `↓` `Boşluk` `PgDn` `Enter` · Geri: `←` `↑` `PgUp` · İlk/son: `Home`/`End`
   - `B` ekranı karartır (izleyiciler siyah ekran görür) · `F` tam ekran (projeksiyon için; tam ekranda slayta tıklamak ilerletir)
   - Sunum kumandaları (clicker) PgUp/PgDn gönderdiği için doğrudan çalışır.
5. **■ Sunumu bitir** ile izleyicilerde "Sunum sona erdi" görünür. Sayfayı yenilese veya kapatsa da sunum sürer; *Canlı sunumlar* listesinden geri dönülür.

**İzleyici**
- Kodu girer (ya da bağlantıyla doğrudan gelir), öğretmenin gösterdiği slaytı tam ekran görür. Geç katılan o anki slayttan başlar; bağlantı koparsa kendiliğinden yeniden bağlanır.
- İzleyici sadece öğretmenin **o ana kadar gösterdiği** slaytların resmini alabilir; ilerideki slaytlara bakamaz, PDF'in tamamı izleyiciye hiç gönderilmez.

**Neden PDF?** Tarayıcılar PPTX dosyasını açamaz. PDF, görünümü PowerPoint'tekiyle aynı tutar. Animasyonlar, geçiş efektleri ve videolar PDF'e aktarılmadığı için çalışmaz; her slayt son haliyle gösterilir.

## Veri

Veritabanı yoktur. Yüklenen sunumlar (slayt resimleri) ve canlı sunumların durumu sunucunun `data/` klasöründe tutulur.

- Ücretsiz Render gibi **diski geçici** ortamlarda sunucu uyuyup uyandığında, yeniden başladığında veya yeni sürüm yüklendiğinde yüklenen sunumlar silinir. Bu yüzden PDF'i **dersten hemen önce** yükleyin; asıl dosya sizin bilgisayarınızda kalır.
- Kalıcı diski olan bir sunucuda (VPS, Render kalıcı disk) sunumlar silinene kadar durur.
- Sunucu çalışırken yeniden başlarsa (disk silinmediyse) canlı sunum aynı kodla kaldığı slayttan devam eder. 12 saat işlem görmeyen sunum kendiliğinden kapanır.
- Slayt resimleri 1920 px genişlikte WebP'dir: yazı ağırlıklı bir slayt ~15-50 KB, fotoğraflı bir slayt ~150-400 KB tutar.

## Yayınlama (Render + slide.mkcaglar.com)

1. Render'da **New → Web Service** ile bu repoyu seçin. Build: `npm install`, Start: `npm start`.
2. **Environment**: `TEACHER_PASSWORD` (öğretmen şifresi). İsteğe bağlı `SESSION_SECRET` (giriş çerezlerini imzalamak için uzun rastgele bir metin; verilmezse şifreden türetilir).
3. **Settings → Custom Domains → Add**: `slide.mkcaglar.com`. Ardından alan adınızın DNS panelinde `slide` için Render'ın gösterdiği adrese bir **CNAME** kaydı ekleyin (ör. `slide → slide-xxxx.onrender.com`). Render HTTPS sertifikasını kendisi alır.

Ücretsiz Render sunucusu 15 dakika kullanılmazsa uyur; ilk açılış 30-60 sn sürer ve uyandığında önceki yüklemeler silinmiş olur.

## Test

```bash
npm test
```
