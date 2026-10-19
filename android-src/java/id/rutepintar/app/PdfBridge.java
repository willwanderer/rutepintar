package id.rutepintar.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class PdfBridge {
    private final Context ctx;
    private Uri lastUri;

    public PdfBridge(Context ctx) {
        this.ctx = ctx;
    }

    @JavascriptInterface
    public String save(String name, String b64) {
        try {
            byte[] data = Base64.decode(b64, 0);
            String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = ctx.getContentResolver();
                ContentValues v = new ContentValues();
                v.put("_display_name", safe);
                v.put("mime_type", "application/pdf");
                v.put("relative_path", "Download/RutePintar");
                Uri uri = cr.insert(Uri.parse("content://media/external/downloads"), v);
                OutputStream os = cr.openOutputStream(uri);
                os.write(data);
                os.close();
                lastUri = uri;
                return "OK|Download/RutePintar/" + safe;
            }
            File dir = ctx.getExternalFilesDir("laporan");
            dir.mkdirs();
            File f = new File(dir, safe);
            FileOutputStream fo = new FileOutputStream(f);
            fo.write(data);
            fo.close();
            lastUri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            return "OK|" + f.getAbsolutePath();
        } catch (Exception e) {
            return "ERR|" + e.toString();
        }
    }

    @JavascriptInterface
    public String open(String name) {
        if (lastUri == null) return "ERR|belum ada file";
        try {
            Intent i = new Intent("android.intent.action.VIEW");
            i.setDataAndType(lastUri, "application/pdf");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            ctx.startActivity(i);
            return "OK";
        } catch (Exception e) {
            return "ERR|" + e.toString();
        }
    }

    @JavascriptInterface
    public String share(String name) {
        if (lastUri == null) return "ERR|belum ada file";
        try {
            Intent i = new Intent("android.intent.action.SEND");
            i.setType("application/pdf");
            i.putExtra("android.intent.extra.STREAM", lastUri);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent c = Intent.createChooser(i, "Bagikan laporan");
            c.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            ctx.startActivity(c);
            return "OK";
        } catch (Exception e) {
            return "ERR|" + e.toString();
        }
    }
}
