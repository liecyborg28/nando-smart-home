# Tinjauan keamanan akhir (Phase 9)

Tinjauan sebelum dianggap siap produksi, dilakukan 2026-11-16. Isinya: apa yang diperiksa, apa yang ditemukan, dan apa yang **masih berisiko**. Cara kerja pengamanan sehari-hari ada di [security.md](security.md).

Ini tinjauan oleh pengembang yang sama dengan penulis kode, ditambah tes otomatis. Itu **bukan** audit independen atau uji penetrasi. Kalau server ini akan mengontrol perangkat yang berisiko (pintu, kunci), pertimbangkan tinjauan pihak ketiga.

## Yang diperiksa

| Area | Cara | Hasil |
|---|---|---|
| Pola berbahaya di `src/` (`eval`, `new Function`, `child_process`, `innerHTML`, `Math.random`) | Pencarian kode | Tidak ada |
| Query SQL | Pencarian penggabungan string pada query | Semua query berparameter |
| Pembacaan konfigurasi | Pencarian `process.env` | Hanya di `src/config/env.ts` |
| Pencetakan langsung | Pencarian `console.*` | Tidak ada; semua lewat logger yang menyaring secret berdasarkan nilai |
| Request keluar | Pencarian `fetch(` | Hanya klien Tuya: host di-allowlist, `redirect: "error"`, batas respons 1 MiB |
| Kebocoran secret di kode | `npm run check:secrets` (400 berkas) | Bersih |
| Dependensi | `npm audit` | 0 kerentanan (per tanggal tinjauan; periksa lagi secara berkala) |
| Tes otomatis | `npm test` | Lihat laporan akhir untuk jumlah terbaru |
| Pengaman benar-benar bekerja | Uji mutasi: pengaman dirusak sengaja, tes harus gagal | 34 pengaman dalam seluruh fase, semuanya tertangkap, kode dipulihkan |
| Server sungguhan | Bundle produksi dijalankan dari folder bersih tanpa `.env`, Postgres dan Tuya asli | Sesuai harapan; tidak ada secret di log atau respons |

## Temuan fase ini (sudah diperbaiki)

1. **Build Next.js menyalin `.env` asli ke `.next/standalone/.env`.** Hash-nya sama dengan `.env` di root, berisi secret Tuya dan URL database. Image Docker yang menyalin folder itu akan membawa secret. *Perbaikan:* `.dockerignore`, penghapusan eksplisit di `Dockerfile`, `.vercelignore`, dan tes `tests/deploy` yang gagal bila aturan itu hilang.
2. **Audit tertulis tanpa ditunggu.** Insert ke `audit_log` dilepas begitu saja; di serverless, fungsi bisa dibekukan setelah respons sehingga catatan aksi kontrol bisa hilang. Di server biasa ini tidak terlihat. *Perbaikan:* catatan yang sedang berjalan dilacak dan platform diminta menunggu (`after()`); tes dan uji mutasi memastikannya. Terbukti di server produksi lokal: baris `denied` dan `failure` muncul di Postgres. **Skenario dibekukannya fungsi sendiri belum bisa direproduksi tanpa Vercel**; lihat pengecekan setelah deploy di [deployment.md](deployment.md).
3. **Deskripsi tool masih menyebut "write API key"** padahal sistemnya sudah token. Membingungkan model dan manusia. *Perbaikan:* diganti "token dengan scope write".

## Risiko yang masih ada

| # | Risiko | Dampak | Penanganan |
|---|---|---|---|
| 1 | **Password Neon dan Access Secret Tuya pernah tertempel di chat** | Siapa pun yang punya akses ke riwayat chat punya akses penuh ke database dan akun Tuya | **Putar keduanya sebelum deploy.** Ini tindakanmu; saya tidak bisa melakukannya |
| 2 | Aplikasi memakai peran database pemilik | Bila ada celah SQL (tidak ditemukan), dampaknya seluruh database | Buat peran khusus aplikasi: hanya `SELECT/INSERT/UPDATE` pada `api_tokens`, `confirmation_nonces`, `audit_log` |
| 3 | Batas laju, anggaran biaya, dan cache per instance | Di serverless banyak instance: batas efektif lebih longgar, kuota API Tuya bisa lebih cepat habis | Redis/Upstash bila perlu. Brute-force token tetap tidak realistis (secret 43 karakter acak) |
| 4 | Token konfirmasi membuktikan panggilan kedua yang disengaja, **bukan** bahwa manusia ditanya | Agent yang salah bisa mengonfirmasi sendiri | Skills mewajibkan bertanya ke pengguna; tetapi tidak ada paksaan teknis. `CONFIRM_ALL_WRITES=true` memperbanyak titik konfirmasi |
| 5 | Kode kategori "berdampak tinggi" adalah dugaan terbaik | Kunci/garasi dengan kode tak dikenal tidak diminta konfirmasi | Aktifkan `CONFIRM_ALL_WRITES=true` untuk server publik; tambahkan kode perangkatmu di `HIGH_IMPACT_CATEGORIES` |
| 6 | Semua device boleh dikontrol oleh token `write` (keputusan pemilik) | Satu token bocor = semua device terkontrol | Token bernama, bisa dicabut, tombol darurat, batas laju, audit |
| 7 | Injeksi prompt lewat nama/nilai device | Teks perangkat bisa mencoba menginstruksikan agent | Disaring, dibatasi panjangnya, dan diberi peringatan "data, bukan instruksi"; **mengurangi, tidak menghilangkan**. Agent tetap harus patuh pada peringatan itu |
| 8 | Perangkat infrared tanpa umpan balik | Hasil kontrol `not_verifiable`; tidak diketahui apakah berhasil | Dilaporkan apa adanya, tidak pernah diklaim sukses |
| 9 | Belum ada kunci idempotensi | Perintah yang terkirim dua kali diterapkan dua kali | Kebanyakan perintah (nyala/atur nilai) wajar diulang; cek `verification` |
| 10 | Belum ada halaman admin web | Token dikelola lewat CLI dari komputer yang memegang `DATABASE_URL` | Halaman admin butuh autentikasi, CSRF, dan sesi tersendiri; sengaja ditunda |
| 11 | Deploy Vercel, image Docker, dan Caddy belum pernah dijalankan | Konfigurasi bisa salah di hari pertama | Daftar pengecekan setelah deploy di [deployment.md](deployment.md) |
| 12 | IP klien di balik proxy Vercel belum terverifikasi | Bila `TRUSTED_PROXY_HOPS` tidak cocok, batas per IP memakai satu keranjang | Pengecekan nomor 2 di deployment.md |
| 13 | Perilaku bahasa natural agent belum diuji dengan model sungguhan | Agent bisa memilih tool yang salah untuk kalimat tertentu | Skills diuji di rumah simulasi; uji dengan `run_agent.py` saat kamu punya `ANTHROPIC_API_KEY` |

## Yang sengaja tidak ada

- Endpoint yang meneruskan permintaan mentah ke Tuya.
- Autentikasi OAuth. Token lebih sederhana dicabut dan diaudit.
- Cookie atau sesi di sisi server.
- Penyimpanan data perangkat di database kita.
