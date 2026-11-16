# Setup lokal

Dari nol sampai server jalan di komputermu. Untuk deploy ke internet, lanjut ke [deployment.md](deployment.md).

## Yang dibutuhkan

- **Node.js 20.9 atau lebih baru** (diuji di Node 24) dan npm.
- Akun **Tuya IoT Platform** (iot.tuya.com) dengan akun **Smart Life** yang sudah berisi device.
- Database **Postgres**. Neon (gratis) cocok; cukup satu database.

## 1. Pasang dependensi

```bash
npm install
```

## 2. Siapkan Tuya

Di iot.tuya.com buat sebuah **Cloud project**, lalu di halaman project catat:

| Di konsol Tuya | Isi di `.env` |
|---|---|
| Access ID / Client ID | `TUYA_ACCESS_ID` |
| Access Secret / Client Secret | `TUYA_ACCESS_SECRET` |
| Data Center | `TUYA_BASE_URL` |

Data center menentukan URL. **Singapore** (umum untuk akun Indonesia) memakai `https://openapi-sg.iotbing.com` (bukan `openapi.tuyasg.com`). Kalau salah, server menjawab bahwa koneksi gagal. Cek data center di Cloud > Development > project kamu > Overview.

Lalu **tautkan akun Smart Life** ke project (di konsol Tuya, menu penautan akun aplikasi / "Link App Account", lalu scan QR dari aplikasi Smart Life; nama menu bisa berubah, ikuti petunjuk Tuya). Tanpa langkah ini daftar device kosong. Tautan ini dilakukan di konsol Tuya, bukan lewat API server ini.

**Access Secret adalah rahasia.** Jangan ditempel di chat, issue, atau commit. Kalau bocor, reset di konsol Tuya.

## 3. Isi `.env`

```bash
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Isi minimal:

```
TUYA_ACCESS_ID=...
TUYA_ACCESS_SECRET=...
TUYA_BASE_URL=https://openapi-sg.iotbing.com

DATABASE_URL=...            # koneksi langsung Neon (untuk migrasi dan CLI token)
DATABASE_URL_POOLED=...     # koneksi pooled Neon (dipakai aplikasi)
CONFIRMATION_SECRET=...     # acak, minimal 32 karakter
```

Membuat `CONFIRMATION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Di Neon, kedua URL ada di tombol **Connect**: pilih koneksi biasa untuk `DATABASE_URL`, dan yang bertanda *pooled* untuk `DATABASE_URL_POOLED`. `.env` sudah di-`.gitignore`; jangan pernah di-commit. Daftar semua variabel beserta penjelasannya ada di `.env.example`.

## 4. Buat tabel

```bash
npm run db:migrate
```

Aman dijalankan berulang. Ia membuat tabel token, nonce konfirmasi, dan audit log.

## 5. Buat token pertama

```bash
npm run token -- create saya-baca --scope read
```

Token (`nsh_...`) **tampil sekali saja**; simpan di tempat aman. Yang tersimpan di database hanya hash-nya, jadi token yang hilang tidak bisa dilihat lagi, hanya diganti. Perintah lain (`list`, `revoke`, `--scope write`, `--expires`) ada di [security.md](security.md#2-token).

## 6. Jalankan

```bash
npm run dev
```

Cek dari terminal lain:

```bash
curl http://localhost:3000/api/health
# {"status":"ok",...}

TOKEN=nsh_...
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/integrations/tuya/status
# "connected": true  berarti kredensial Tuya dan data center benar

curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/devices
```

Untuk mencoba sebagai klien MCP:

```bash
NANDO_TOKEN=$TOKEN npx tsx examples/mcp-client/list-tools.ts
```

Klien lain (Agno, Claude Code, ...): [clients.md](clients.md).

## 7. Tes

```bash
npm run typecheck
npm test              # tes otomatis dengan penyedia palsu, tanpa jaringan
npm run test:live     # baca-saja ke Tuya asli + Postgres (memakai skema sementara)
npm run check:secrets # pindai kebocoran secret
```

`test:live` butuh `.env` terisi. Tes yang benar-benar menyalakan/mematikan device hanya jalan bila kamu menyetel `LIVE_CONTROL=1` secara sengaja.

Aktifkan hook pra-commit sekali: `git config core.hooksPath .githooks`.

## Masalah umum

| Gejala | Penyebab |
|---|---|
| `connected: false` dari `/api/integrations/tuya/status` | Access ID/Secret salah, atau `TUYA_BASE_URL` bukan data center project-mu |
| Daftar device kosong | Akun Smart Life belum ditautkan ke project Tuya |
| 401 | Token salah, sudah dicabut, atau kedaluwarsa. Jawabannya sengaja sama untuk semua sebab |
| 503 pada semua request | Database tidak terjangkau; server sengaja menolak semuanya daripada menebak |
| Host/origin ditolak (403) | `MCP_ALLOWED_HOSTS` diisi tetapi hostname-mu belum ada di dalamnya (kosongkan variabelnya bila tidak ingin membatasi), atau origin browser belum ada di `MCP_ALLOWED_ORIGINS` |
| `npm test` gagal di semua file dengan `Cannot read properties of undefined (reading 'config')` (Windows) | Direktori kerja berhuruf kecil (`d:\...`), biasanya dari `cd /d/...` di Git Bash. Jalankan dari `D:\...` (huruf besar), misalnya lewat PowerShell |
