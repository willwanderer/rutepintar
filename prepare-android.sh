#!/usr/bin/env bash
# Membuat proyek android/ + menerapkan izin lokasi, ikon, splash, versi.
set -euo pipefail
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0}"
[ -d android ] || npx cap add android
MANIFEST=android/app/src/main/AndroidManifest.xml
if ! grep -q ACCESS_FINE_LOCATION "$MANIFEST"; then
  sed -i 's#</manifest>#    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />\n    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n</manifest>#' "$MANIFEST"
fi
cp -r android-res/. android/app/src/main/res/
# jembatan PDF (RutePdf) + MainActivity + file_paths
cp -r android-src/java/. android/app/src/main/java/
cp -r android-src/res/. android/app/src/main/res/
sed -i -E "s/versionCode [0-9]+/versionCode ${VERSION_CODE}/; s/versionName \"[^\"]*\"/versionName \"${VERSION_NAME}\"/" android/app/build.gradle
npx cap sync android
