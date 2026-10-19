# RutePintar (Android, Capacitor)

Kode web ada di `www/`. APK dibangun oleh GitHub Actions.

## Build lewat GitHub
1. Buat repo baru, push seluruh isi folder ini ke branch `main`.
2. Tab **Actions** > **Build APK** (jalan otomatis tiap push, atau *Run workflow*).
3. Unduh `RutePintar-apk` dari **Artifacts**.

Tanpa secret hasilnya APK **debug**, tanda tangannya berbeda dari APK lama:
uninstall dulu versi lama (ekspor data dulu).

## Menimpa APK lama (tanda tangan sama)
Tambahkan secret repo: `KEYSTORE_BASE64` (`base64 -w0 kunci.jks`), `KEYSTORE_PASSWORD`,
`KEY_ALIAS`, `KEY_PASSWORD`. Harus keystore yang sama dengan APK v3.

## Build lokal
    npm install
    VERSION_CODE=2 ./prepare-android.sh
    cd android && ./gradlew assembleDebug
