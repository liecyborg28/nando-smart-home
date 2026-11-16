# Deployment

Dua jalur. **Vercel** adalah jalur utama (tanpa Dockerfile, HTTPS dan domain diurus platform). **Docker** adalah cadangan kalau kamu mau hosting sendiri.

Apa pun jalurnya, urutannya sama: siapkan secret, migrasi database, deploy, buat token, verifikasi. Setup lokal ada di [setup.md](setup.md).

> **Status verifikasi.** Yang sudah terbukti di mesin pengembangan: build produksi, bundle standalone yang jalan dari folder bersih tanpa `.env`, dan penulisan audit ke Postgres lewat server produksi. **Belum pernah dijalankan:** deploy sungguhan di Vercel, image Docker (Docker tidak terpasang di mesin pengembangan), dan Caddy. Bagian bertanda "verifikasi setelah deploy" adalah pengecekan yang harus kamu jalankan sendiri.

## Sebelum deploy apa pun

- [ ] **Putar (reset) dua secret yang pernah tertempel di chat selama pengembangan:** password database Neon, dan Access Secret Tuya (konsol Tuya). Perbarui `.env` dan variabel di platform.
- [ ] `CONFIRMATION_SECRET` baru, acak, 32+ karakter. Jangan pakai ulang nilai dev.
- [ ] `npm run typecheck && npm test && npm run check:secrets && npm audit` bersih (jalankan dari `D:\...` huruf besar di Windows).
- [ ] `git ls-files | grep -E '^\.env($|\.)'` hanya boleh menampilkan `.env.example`.
- [ ] Migrasi database sudah dijalankan: `npm run db:migrate` (dari komputermu, memakai `DATABASE_URL` langsung).

## Jalur 1: Vercel

### Kenapa cocok, dan apa bedanya

Server ini stateless (tidak ada sesi), jadi cocok untuk serverless. `vercel.json` memilih region **sin1** (Singapura), dekat dengan Tuya dan Neon (`ap-southeast-1`) supaya tiap panggilan ke Tuya tidak menambah jeda antarbenua. Setiap rute dibatasi 30 detik (`maxDuration`).

Beda dengan server biasa:

| Hal | Di Vercel |
|---|---|
| Rate limit, anggaran biaya, cache token dan cache Tuya | Disimpan di memori **per instance**. Vercel bisa menjalankan banyak instance sekaligus, jadi batasnya **lebih longgar dari angka di `.env`**. Pencabutan token, nonce konfirmasi, dan audit tetap benar karena ada di Postgres. Untuk batas yang ketat lintas-instance perlu penyimpanan bersama (mis. Redis/Upstash), belum dibuat. |
| Catatan audit | Ditulis ke Postgres dan platform diminta menunggu sampai selesai (`after()`), supaya tidak hilang saat fungsi dibekukan. |
| Log | Retensi log Vercel terbatas. `audit_log` di Postgres adalah catatan permanen. |
| Permintaan pertama setelah sepi | Lebih lambat (cold start fungsi, dan Neon yang tertidur). |
| Paket | Hobby hanya untuk pemakaian pribadi non-komersial (aturan Vercel). |

### Langkah

1. **Commit dan push** kode ke GitHub (repo ini belum punya commit). Pastikan `.env` tidak ikut.
2. Di vercel.com: **Add New > Project**, pilih repo. Framework terdeteksi sebagai Next.js; `vercel.json` sudah mengatur region.
3. **Environment Variables** (Production). Hanya yang ini; jangan salin seluruh `.env`:

   | Variabel | Nilai |
   |---|---|
   | `TUYA_ACCESS_ID`, `TUYA_ACCESS_SECRET` | dari konsol Tuya (nilai yang sudah diputar) |
   | `TUYA_BASE_URL` | `https://openapi-sg.iotbing.com` |
   | `DATABASE_URL_POOLED` | URL pooled Neon. **Jangan** isi `DATABASE_URL` (koneksi langsung) di sini; hanya migrasi dan CLI yang memakainya, dan itu jalan dari komputermu. |
   | `CONFIRMATION_SECRET` | acak 32+ karakter |
   | `MCP_ALLOWED_HOSTS` | hostname domainmu, mis. `home.contoh.com` (tanpa `https://`, tanpa port) |
   | `MCP_ALLOWED_ORIGINS` | sama; tambahkan hostname dashboard bila ada |
   | `TRUSTED_PROXY_HOPS` | `1` |
   | `CONFIRM_ALL_WRITES` | `true` (disarankan untuk server publik) |
   | `WRITE_RATE_LIMIT_PER_MINUTE` | `10` |

   `NODE_ENV=production` diatur Vercel, dan itu otomatis mewajibkan HTTPS.
4. **Domain**: tambahkan domainmu di Project > Settings > Domains, dan masukkan hostname-nya ke `MCP_ALLOWED_HOSTS`. Server menolak Host yang tidak ada di daftar; `*.vercel.app` hanya bisa dipakai bila hostname itu juga kamu tambahkan.
5. **Deploy**, lalu buat token dari komputermu (database-nya sama):

   ```bash
   npm run token -- create agno-baca --scope read
   ```

### Verifikasi setelah deploy

```bash
BASE=https://home.contoh.com
curl $BASE/api/health                                   # {"status":"ok",...}
curl -H "Authorization: Bearer $TOKEN" $BASE/api/integrations/tuya/status   # connected: true
curl -H "Authorization: Bearer $TOKEN" $BASE/api/devices
NANDO_TOKEN=$TOKEN NANDO_MCP_URL=$BASE/mcp npx tsx examples/mcp-client/list-tools.ts
```

Tiga hal yang **harus** dicek karena belum pernah dicoba di Vercel:

1. **Perlindungan deployment Vercel.** Bila `/api/health` menjawab halaman login Vercel, bukan JSON, "Deployment Protection" menghalangi klien API. Atur di Project > Settings > Deployment Protection agar domain produksi terbuka (token kita yang menjaga pintunya).
2. **IP klien benar.** Kirim satu aksi yang pasti ditolak, lalu lihat IP yang tercatat:

   ```bash
   curl -X POST -H "Authorization: Bearer $READ_TOKEN" -H "Content-Type: application/json" \
     -d '{"commands":[{"code":"x","value":true}]}' $BASE/api/devices/tidak-ada/commands    # 403
   ```
   ```sql
   select at, actor_name, outcome, client_ip from audit_log order by at desc limit 3;
   ```
   `client_ip` harus IP publikmu. Kalau berisi `unknown`, `TRUSTED_PROXY_HOPS` tidak cocok dengan proxy Vercel (batas per IP akan memakai satu keranjang bersama).
3. **Audit tertulis.** Baris dari langkah 2 harus muncul di `audit_log`. Kalau tidak, catatan audit hilang saat fungsi dibekukan; laporkan.

## Jalur 2: Docker (hosting sendiri)

File: `Dockerfile` (target `runner` untuk server, bawaan; target `tools` untuk token CLI dan migrasi), `docker-compose.yml`, `Caddyfile`, `.dockerignore`.

Rancangannya:

- Image `runner` hanya berisi bundle standalone dan berjalan sebagai user `node` (bukan root). Tidak ada secret di dalam image; konfigurasi masuk saat jalan lewat `env_file`.
- Hanya **Caddy** yang terbuka ke internet (port 80/443, HTTPS otomatis dari Let's Encrypt). Aplikasi tidak punya port publik.
- Filesystem aplikasi read-only, semua capability dibuang, `no-new-privileges`.
- `tools` hanya jalan bila dipanggil, untuk token CLI dan migrasi.

```bash
cp .env.example .env            # isi, termasuk DOMAIN=home.contoh.com
                                # dan MCP_ALLOWED_HOSTS/MCP_ALLOWED_ORIGINS=home.contoh.com
docker compose run --rm tools db:migrate
docker compose run --rm tools token -- create agno-baca --scope read
docker compose up -d
docker compose ps               # app harus "healthy"
```

`TRUSTED_PROXY_HOPS=1` sudah diatur oleh compose karena Caddy adalah satu proxy di depan aplikasi. Domain harus mengarah ke IP server, dan port 80/443 terbuka di firewall.

**Dua catatan penting:**

- Next.js menyalin `.env` ke `.next/standalone/.env` pada setiap build (terbukti di build ini). `.dockerignore` menghalangi `.env` masuk ke build context, dan `Dockerfile` menghapusnya lagi sebagai lapis kedua. Tes `tests/deploy` memeriksa kedua aturan itu. Bila kamu mendeploy dengan cara lain, pastikan folder `standalone` tidak membawa `.env`.
- Image belum pernah di-build di mesin pengembangan. Percobaan pertama: `docker compose build`, lalu `docker compose up`, dan baca log bila `app` tidak sehat.

## Pemantauan

Server sengaja tidak memuat agen monitoring; pakai yang sudah ada di platform dan database.

| Apa | Caranya |
|---|---|
| **Hidup/mati** | `GET /api/health` tanpa token menjawab `{"status":"ok"}`. Ini hanya menandakan prosesnya hidup. Pasang uptime monitor di sana. |
| **Tuya dan database sehat** | `GET /api/integrations/tuya/status` dengan token baca: `connected: false` berarti kredensial Tuya atau jaringan bermasalah. Dengan token, `/api/health` juga menampilkan status penyedia, database, dan kontrol. Buat token baca khusus untuk monitor. |
| **Log** | Satu baris JSON per kejadian, diberi `requestId`. Token, secret Tuya, dan URL database disaring dari log. |
| **Jejak aksi** | Tabel `audit_log` (lihat bawah). Cocokkan dengan header `X-Request-Id` di respons. |

Kueri yang berguna:

```sql
-- Semua aksi kontrol, terbaru dulu
select at, actor_name, action, outcome, error_code, device_ids, client_ip
from audit_log where write order by at desc limit 50;

-- Penolakan per token dalam 24 jam (lonjakan = token bocor atau klien salah konfigurasi)
select actor_name, count(*) from audit_log
where outcome = 'denied' and at > now() - interval '1 day' group by 1 order by 2 desc;

-- Token yang lama tidak dipakai (kandidat untuk dicabut)
select id, name, scopes, last_used_at from api_tokens
where revoked_at is null order by last_used_at nulls first;
```

Yang patut diberi peringatan: `/api/health` tidak 200, `connected: false`, banyak 5xx, lonjakan 401 (tebakan token) atau 429, dan aksi kontrol di jam yang tidak wajar.

## Operasi

- **Token bocor / klien hilang:** `npm run token -- revoke <id>` (berlaku ≤ 5 detik). Prosedur insiden lengkap: [security.md](security.md#7-saat-ada-insiden).
- **Matikan kontrol darurat:** setel `CONTROL_ENABLED=false` lalu deploy ulang/restart. Pembacaan tetap jalan.
- **Ganti secret:** ubah di platform, deploy ulang. Mengganti `CONFIRMATION_SECRET` membatalkan konfirmasi yang tertunda, tanpa efek lain.
- **Migrasi baru:** jalankan `npm run db:migrate` **sebelum** deploy kode yang membutuhkannya.
- **Backup:** data yang ada hanya token, nonce, dan audit. Neon menyediakan point-in-time restore; cek retensi di paketmu.

## Daftar periksa akhir

- [ ] Secret Neon dan Tuya yang pernah tertempel sudah diputar
- [ ] Database memakai peran khusus aplikasi (hanya `SELECT/INSERT/UPDATE` pada tiga tabel) bila memungkinkan; lihat [security.md](security.md#8-batas-yang-diketahui)
- [ ] `CONFIRM_ALL_WRITES=true` dan `WRITE_RATE_LIMIT_PER_MINUTE` rendah
- [ ] Setiap klien punya token sendiri; token `write` hanya untuk agent yang memang mengontrol
- [ ] Tiga pengecekan "setelah deploy" di atas lulus
- [ ] Uptime monitor terpasang
