# Keamanan Nando Smart Home

Dokumen operasional: cara kerja pengamanan, cara mengelola token, profil produksi, dan langkah saat ada insiden.

## 1. Lapisan pengamanan (dari luar ke dalam)

Setiap request ke `/mcp` **dan** `/api/*` (REST) melewati ini berurutan, lewat satu pipeline yang sama (`src/http/pipeline.ts`). Gagal di satu lapisan = berhenti di situ.

| # | Lapisan | Yang dicegah |
|---|---|---|
| 1 | Pembatas per IP (sebelum autentikasi) | Banjir request, tebak-tebak token |
| 2 | Wajib HTTPS | Token terkirim polos lewat jaringan |
| 3 | Allowlist Host/Origin | DNS rebinding dari browser |
| 4 | Autentikasi token (Postgres) | Akses tanpa izin; token dicabut berlaku |
| 5 | Pembatas per token + batas konkurensi | Satu klien memonopoli server |
| 6 | Scope per tool (`read` / `write`) | Token baca dipakai mengontrol |
| 7 | Anggaran biaya per token | Menghabiskan kuota API Tuya |
| 8 | Validasi capability + nilai | Perintah ke properti yang tidak ada/di luar batas |
| 9 | Konfirmasi dua langkah (aksi berdampak tinggi) | Aksi berbahaya tanpa persetujuan |
| 10 | Verifikasi hasil + audit | Mengklaim sukses tanpa bukti; tak ada jejak |

Data dari device (nama, nilai status) selalu dianggap **tidak tepercaya**: dibersihkan, dibatasi ukurannya, dan diberi penanda di setiap hasil agar tidak dibaca agent sebagai instruksi.

## 2. Token

Bentuk: `nsh_<id>.<secret>`. Hanya `id` dan **hash SHA-256 dari secret** yang disimpan di database. Token asli tampil **sekali** saat dibuat.

```bash
npm run token -- create agno-baca --scope read           # hanya membaca
npm run token -- create orb-kontrol --scope write         # membaca + mengontrol
npm run token -- create sementara --scope read --expires 7d
npm run token -- list
npm run token -- revoke <id> --reason "laptop hilang"
npm run token -- revoke-all --yes --reason "insiden"
```

- Token tidak kedaluwarsa kecuali diberi `--expires`.
- Pencabutan berlaku dalam **`TOKEN_CACHE_TTL_SECONDS`** (default 5 detik; `0` = seketika, tiap request cek database).
- Kalau database tidak terjangkau, server **menolak semua request** (503). Ia tidak pernah mengizinkan diam-diam.
- Beri tiap klien token sendiri dengan nama yang jelas. Nama itu muncul di audit log.
- Beri token `write` **hanya** ke agent yang memang bertugas mengontrol.

## 3. Profil produksi (internet publik)

Wajib di `.env`:

```
NODE_ENV=production
DATABASE_URL=...            # koneksi langsung (migrasi + CLI)
DATABASE_URL_POOLED=...     # koneksi pooled (aplikasi)
CONFIRMATION_SECRET=...     # acak, >= 32 karakter
MCP_ALLOWED_HOSTS=home.contoh.com
MCP_ALLOWED_ORIGINS=home.contoh.com
TRUSTED_PROXY_HOPS=1        # jumlah reverse proxy di depan (Caddy/nginx/Cloudflare)
CONFIRM_ALL_WRITES=true     # disarankan: setiap kontrol butuh konfirmasi
WRITE_RATE_LIMIT_PER_MINUTE=10
```

`TRUSTED_PROXY_HOPS` **harus** sesuai jumlah proxy. Bila 0 di belakang proxy TLS, semua request tampak HTTP biasa dan ditolak. Bila terlalu besar, penyerang bisa memalsukan IP/protokol lewat header `X-Forwarded-*`.

Contoh Caddy (TLS otomatis, satu proxy):

```
home.contoh.com {
    reverse_proxy localhost:3000
}
```

Server mencatat peringatan saat start bila konfigurasi produksi berisiko (host hanya localhost, tanpa proxy tepercaya, tanpa `CONFIRMATION_SECRET`).

## 4. Batas yang berlaku

| Batas | Default | Env |
|---|---|---|
| Request per IP per menit (sebelum auth) | 240 | `IP_RATE_LIMIT_PER_MINUTE` |
| Gagal autentikasi per IP per menit | 20 | (tetap) |
| Request per token per menit | 120 | `RATE_LIMIT_PER_MINUTE` |
| Anggaran biaya per token per menit | 300 | `COST_BUDGET_PER_MINUTE` |
| Operasi kontrol per token per menit | 30 | `WRITE_RATE_LIMIT_PER_MINUTE` |
| Request bersamaan per token | 8 | `MAX_CONCURRENT_PER_TOKEN` |
| Ukuran body request | 64 KiB | (tetap) |
| Ukuran respons Tuya | 1 MiB | (tetap) |

Biaya per panggilan mengikuti jumlah panggilan ke Tuya: daftar/detail = 1, status = 2, status banyak device = 2 x jumlah device, capability = 2, katalog capability = 25, tiap aksi kontrol = 6. Cache singkat (daftar 15 dtk, status 3 dtk, spesifikasi 10 mnt) mengurangi panggilan berulang; jalur kontrol selalu membaca data segar.

### REST dan CORS

- REST (`/api/*`) memakai pipeline, token, batas, anggaran biaya, konfirmasi, dan audit yang sama dengan MCP. Detail dan contoh: [api-reference.md](api-reference.md).
- Dashboard berbasis browser: tambahkan hostname-nya ke `MCP_ALLOWED_ORIGINS`. Origin yang diizinkan mendapat `Access-Control-Allow-Origin` dengan origin itu persis (tidak pernah `*`), tanpa cookie. Origin lain mendapat 403. Beri dashboard token baca sendiri.
- Aksi berdampak tinggi lewat REST dijawab `428` (bukan 200) sehingga klien yang hanya memeriksa kode status tidak salah mengira sukses.

## 5. Aksi berdampak tinggi

Panggilan pertama **tidak dieksekusi** dan mengembalikan token konfirmasi; pengguna harus setuju, lalu panggilan yang sama diulang dengan token itu. Token terikat ke token klien, device, dan isi perintah, berlaku 5 menit, dan hanya sekali pakai (dicatat di Postgres sehingga aman lintas instance).

Dianggap berdampak tinggi: kategori di `HIGH_IMPACT_CATEGORIES` (default kunci pintu, pintu garasi, keran air) dan perintah yang kodenya memuat `lock`, `valve`, `garage`, atau `siren`. `CONFIRM_ALL_WRITES=true` memperluasnya ke semua kontrol.

Batas yang harus dipahami: token konfirmasi membuktikan **panggilan kedua yang disengaja**, bukan bahwa manusia ditanya. Skills mewajibkan agent bertanya ke pengguna di antara dua panggilan.

## 6. Audit

- Semua kontrol, penolakan, dan kegagalan disimpan di tabel `audit_log` (token, nama, aksi, device, hasil, request-id, IP, user-agent). Pembacaan biasa hanya masuk log stream.
- Setiap respons membawa `X-Request-Id`; cocokkan dengan kolom `request_id`.
- Log tidak berisi token, secret Tuya, atau URL database (dibersihkan berdasarkan nilai dan pola).

## 7. Saat ada insiden

| Kejadian | Tindakan |
|---|---|
| Sebuah token bocor / klien hilang | `npm run token -- revoke <id>`. Berlaku <= 5 detik. Buat token baru untuk klien itu. |
| Tidak yakin token mana yang bocor | `npm run token -- revoke-all --yes`, lalu buat ulang satu per klien. |
| Ada kontrol mencurigakan | Matikan kontrol: `CONTROL_ENABLED=false` lalu restart. Tool kontrol hilang dari discovery, bacaan tetap jalan. Lalu periksa `audit_log`. |
| `DATABASE_URL` bocor | Reset password di dashboard Neon, perbarui `.env`, restart. Periksa tabel `api_tokens` dan `audit_log` untuk entri yang tidak dikenal; `revoke-all`. |
| Tuya Access Secret bocor | Reset di iot.tuya.com, perbarui `.env`, restart. |
| `CONFIRMATION_SECRET` bocor | Ganti nilainya dan restart (konfirmasi yang tertunda otomatis tidak berlaku). |

Mencabut key **tidak** membatalkan perintah yang sudah dikirim ke device; periksa perangkat secara fisik bila perlu.

## 8. Batas yang diketahui

- **Semua device boleh dikontrol** oleh token `write` (keputusan pemilik). Penyeimbangnya: konfirmasi, rate limit, token yang bisa dicabut, tombol darurat, audit.
- **Pembatas laju dan cache ada di memori satu instance.** Untuk banyak instance (termasuk serverless seperti Vercel) perlu penyimpanan bersama (mis. Redis); tanpa itu batas efektifnya lebih longgar dari angka di `.env`. Single-use konfirmasi, pencabutan token, dan audit sudah lintas instance karena ada di Postgres.
- **Perangkat infrared tidak punya umpan balik**: hasilnya selalu "tidak dapat diverifikasi".
- **Belum ada halaman admin web**; pengelolaan token lewat CLI. Halaman admin butuh autentikasi terpisah, CSRF, dan sesi aman.
- **Peran database**: aplikasi memakai peran pemilik. Lebih aman memakai peran khusus yang hanya boleh `SELECT/INSERT/UPDATE` pada `api_tokens`, `confirmation_nonces`, `audit_log`, terpisah dari peran admin untuk migrasi dan CLI.
- Kode kategori "berdampak tinggi" adalah dugaan terbaik dan belum diuji terhadap perangkat nyata.

## 9. Verifikasi

```bash
npm run typecheck && npm test       # tes otomatis
npm run test:live                    # tes baca-saja ke Tuya dan Postgres (skema sementara)
npm run check:secrets                # pindai kebocoran secret (hook pra-commit memakai ini)
npm audit                            # kerentanan dependensi
```

Aktifkan hook sekali: `git config core.hooksPath .githooks`.

Hasil tinjauan akhir dan daftar risiko yang masih ada: [security-review.md](security-review.md). Cara deploy dan pemantauan: [deployment.md](deployment.md).
