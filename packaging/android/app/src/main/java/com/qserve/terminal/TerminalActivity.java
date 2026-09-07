package com.qserve.terminal;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;

/**
 * QServe Terminal.
 *
 * A window onto the restaurant's own server. The whole product — the menu, the
 * orders, the kitchen board, the till — is served by the computer in the
 * restaurant; this app exists so that a station is a thing somebody taps on a
 * home screen rather than a URL they have to keep in a browser, and so that a
 * kitchen screen stays awake and stays on the board.
 *
 * It deliberately holds almost nothing: one address, remembered. There is no
 * account, no cache of the menu, no copy of an order. A lost phone is a lost
 * phone, not a data breach.
 */
public class TerminalActivity extends Activity {

    private static final String PREFS = "qserve.terminal";
    private static final String KEY_ADDRESS = "address";

    private WebView web;
    private View setup;
    private EditText address;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_terminal);

        web = findViewById(R.id.web);
        setup = findViewById(R.id.setup);
        address = findViewById(R.id.address);
        Button connect = findViewById(R.id.connect);

        // A kitchen screen that sleeps is a kitchen screen that misses a
        // ticket, and a table's menu that sleeps mid-order loses the order.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        web.setBackgroundColor(Color.parseColor("#101418"));

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Everything the restaurant serves stays in this window; a link
                // to anywhere else is not this app's business.
                return !sameHost(request.getUrl().toString());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                showSetup(getString(R.string.unreachable_body));
            }
        });

        connect.setOnClickListener(v -> {
            String typed = address.getText().toString().trim();
            if (TextUtils.isEmpty(typed)) {
                Toast.makeText(this, R.string.address_needed, Toast.LENGTH_LONG).show();
                return;
            }
            String url = normalise(typed);
            prefs().edit().putString(KEY_ADDRESS, url).apply();
            open(url);
        });

        String saved = prefs().getString(KEY_ADDRESS, null);
        if (saved == null) {
            address.setText("http://");
            address.setSelection(address.getText().length());
        } else {
            open(saved);
        }
    }

    /** The station this device is bound to, or nothing on a fresh install. */
    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * People paste what they were given. "qserve-rest-000001.local:7020" and
     * "http://192.168.1.9:7020/" are the same intent, and both should work.
     */
    private String normalise(String typed) {
        String url = typed;
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://" + url;
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        return url;
    }

    private boolean sameHost(String url) {
        String saved = prefs().getString(KEY_ADDRESS, null);
        if (saved == null) return false;
        try {
            return android.net.Uri.parse(url).getHost() != null
                && android.net.Uri.parse(url).getHost().equals(android.net.Uri.parse(saved).getHost());
        } catch (Exception ignored) {
            return false;
        }
    }

    private void open(String url) {
        setup.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(url);
    }

    private void showSetup(String message) {
        web.setVisibility(View.GONE);
        setup.setVisibility(View.VISIBLE);
        String saved = prefs().getString(KEY_ADDRESS, "");
        address.setText(saved);
        if (message != null) Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    @Override
    public void onBackPressed() {
        // Back inside the restaurant's own pages behaves as it does in a
        // browser; back at the first page returns to the address form rather
        // than dropping a member of staff onto their home screen mid-service.
        if (web.getVisibility() == View.VISIBLE && web.canGoBack()) {
            web.goBack();
            return;
        }
        if (web.getVisibility() == View.VISIBLE) {
            showSetup(null);
            return;
        }
        super.onBackPressed();
    }
}
