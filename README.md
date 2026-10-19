# RutePintar

Aplikasi Android perencana rute dengan banyak tujuan (mirip RouteXL). Masukkan beberapa alamat, aplikasi mengurutkannya agar perjalanan paling cepat, lalu menggambar rutenya di peta.

## Alur pemakaian

1. **Buat rute** dengan nama (mis. "Antar paket Senin"). Semua rute tersimpan di layar awal; bisa diganti nama atau dihapus.
2. **Tambah titik** ke rute itu lewat tombol "+ Titik", kolom pencarian (alamat, tempat, atau koordinat), ketuk peta, atau impor banyak titik sekaligus. Setiap titik punya:
   - **Nama**
   - **Lokasi** (alamat atau koordinat `lat,lng`; bisa dicari, diketik, atau dipilih di peta)
   - **Keterangan** (catatan bebas)
3. **Pilih titik yang ikut rute** dengan kotak centang di tiap titik, lalu tentukan **Mulai** dan **Akhir** dari daftar. Bila titik akhir tidak dipilih, aplikasi mencari akhir terbaik (atau kembali ke titik mulai bila opsinya dicentang).
4. Ketuk **Cari rute tercepat**: titik di antara mulai dan akhir diurutkan otomatis, garis rute digambar, dan jarak/waktu per ruas serta total ditampilkan.
5. Di setiap titik ada tombol **Google Maps** untuk melihat titik itu di aplikasi Google Maps. Tombol **Navigasi** membuka seluruh rute (maksimal 9 titik antara, batas Google Maps).

## Fitur lain

- Impor teks/CSV, satu baris per titik: `alamat`, `lat,lng`, atau lengkap `Nama | Alamat atau lat,lng | Keterangan`
- Pengurutan: solusi pasti sampai 9 titik, heuristik 2-opt + relocate untuk lebih banyak (maksimal 100 titik per rute)
- Atur urutan manual (naik/turun) untuk titik di antara mulai dan akhir, geser penanda di peta
- Bagikan rute (nama, titik, keterangan, tautan Google Maps) dan Lokasi saya (GPS)
- Data tersimpan otomatis di perangkat; tombol kembali Android berpindah antar layar

## Layanan yang dipakai (gratis, tanpa API key)

| Fungsi | Layanan |
| --- | --- |
| Peta | OpenStreetMap (tile) + Leaflet |
| Pencarian alamat | Nominatim |
| Jarak/waktu dan garis rute | OSRM (server demo publik) |

Catatan: server demo OSRM dan Nominatim cocok untuk pemakaian pribadi atau uji coba. Untuk dipakai banyak orang atau komersial, pasang OSRM sendiri dan ganti konstanta `OSRM` / `NOMINATIM` di `www/app.js`. Aplikasi ini membutuhkan koneksi internet.

## Membuat APK lewat GitHub

1. Buat repositori baru di GitHub, lalu unggah seluruh isi proyek ini (termasuk folder `.github`).
   ```bash
   git init
   git add .
   git commit -m "RutePintar"
   git branch -M main
   git remote add origin https://github.com/USERNAME/NAMA-REPO.git
   git push -u origin main
   ```
2. Buka tab **Actions** di repositori. Workflow **Build APK** berjalan otomatis setiap push ke `main` (atau jalankan manual lewat **Run workflow**). Prosesnya sekitar 5-10 menit.
3. Setelah hijau, ambil APK di salah satu tempat:
   - **Releases** (sisi kanan halaman repositori): file `RutePintar.apk`, bisa diunduh langsung dari HP
   - **Actions > run terakhir > Artifacts**: `RutePintar-apk` (berupa zip)
4. Di HP, buka file APK dan izinkan "Instal dari sumber tidak dikenal" bila diminta.

APK yang dihasilkan adalah build *debug* (ditandatangani kunci debug), cukup untuk dipasang langsung. Untuk Google Play Store, buat build *release* dengan keystore sendiri.

## Menjalankan di komputer (opsional)

```bash
npm install
npm run prepare-web
npm test            # tes solver
# buka www/index.html lewat server statis, mis.:
npx serve www
```

## Struktur

```
www/              aplikasi web (index.html, app.js, solver.js, style.css)
scripts/          penyalin Leaflet dan tes solver
.github/workflows build-apk.yml (pembuat APK)
capacitor.config.json
```

Folder `android/` tidak disimpan di repositori; dibuat otomatis oleh workflow (`npx cap add android`).

## Mengubah nama, ikon, atau ID aplikasi

- Nama dan ID paket: `capacitor.config.json` (`appName`, `appId`)
- Ikon: tambahkan paket `@capacitor/assets` dan folder `assets/` bila ingin ikon sendiri
