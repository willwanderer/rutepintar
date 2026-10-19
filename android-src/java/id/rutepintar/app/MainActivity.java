package id.rutepintar.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Jembatan JS -> native untuk menyimpan/membuka/membagikan PDF laporan (window.RutePdf).
        getBridge().getWebView().addJavascriptInterface(new PdfBridge(this), "RutePdf");
    }
}
