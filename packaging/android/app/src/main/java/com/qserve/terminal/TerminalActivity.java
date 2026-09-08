package com.qserve.terminal;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;

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
 *
 * Three jobs beyond showing the page, each of which the page cannot do itself:
 * reading a station's printed code with the camera, handing the page the
 * clipboard, and keeping the connection alive while the screen is off.
 */
public class TerminalActivity extends ComponentActivity {

    private static final String PREFS = "qserve.terminal";
    private static final String KEY_ADDRESS = "address";

    private WebView web;
    private View setup;
    private EditText address;
    private TextView title;

    /**
     * The host of the page currently loaded, kept on this side so the clipboard
     * bridge can check it without touching the WebView from another thread.
     */
    private volatile String loadedHost;

    private ActivityResultLauncher<Intent> scanner;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_terminal);

        web = findViewById(R.id.web);
        setup = findViewById(R.id.setup);
        address = findViewById(R.id.address);
        title = findViewById(R.id.title);
        Button connect = findViewById(R.id.connect);
        Button scan = findViewById(R.id.scan);

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

        /*
         * The clipboard, handed to the restaurant's own pages.
         *
         * Every screen in QServe puts a paste button in every box, and on this
         * device that button is the difference between entering a licence key
         * and dictating one. The browser's own Clipboard API is not available
         * to those pages and never will be: they are served over plain HTTP on
         * the restaurant's wire, which browsers rightly refuse to treat as a
         * secure context, and there is no certificate authority reachable from
         * a building with no internet.
         *
         * So the app reads it, under two conditions that keep this from being a
         * way for any page to rifle through somebody's clipboard: the bridge is
         * only ever attached to the restaurant's own host, and every call
         * re-checks the page asking. Android also shows its own "pasted from
         * clipboard" notice, which is right — the person should see it.
         */
        web.addJavascriptInterface(new ClipboardBridge(), "QServeNative");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Everything the restaurant serves stays in this window; a link
                // to anywhere else is not this app's business.
                return !sameHost(request.getUrl().toString());
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                loadedHost = hostOf(url);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // Only the page itself: one missing image is not a reason to
                // throw a member of staff back to a settings screen.
                if (!request.isForMainFrame()) return;
                showSetup(true);
            }
        });

        scanner = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), result -> {
                if (result.getResultCode() != RESULT_OK || result.getData() == null) return;
                String scanned = result.getData().getStringExtra(ScannerActivity.EXTRA_RESULT);
                if (scanned == null || scanned.isEmpty()) return;

                // A station's code is a link to the restaurant's computer. If
                // somebody has pointed this at a code from somewhere else, say
                // so rather than loading whatever it was.
                if (!scanned.startsWith("http://") && !scanned.startsWith("https://")) {
                    Toast.makeText(this, R.string.scan_not_a_station, Toast.LENGTH_LONG).show();
                    return;
                }
                remember(scanned);
                open(prefs().getString(KEY_ADDRESS, scanned));
            });

        scan.setOnClickListener(v ->
            scanner.launch(new Intent(this, ScannerActivity.class)));

        connect.setOnClickListener(v -> {
            String typed = address.getText().toString().trim();
            if (TextUtils.isEmpty(typed)) {
                Toast.makeText(this, R.string.address_needed, Toast.LENGTH_LONG).show();
                return;
            }
            String url = normalise(typed);
            remember(url);
            open(url);
        });

        // A scanned code wins over anything remembered: somebody pointing a
        // camera at a station's code is telling this device where it belongs.
        if (openFromIntent(getIntent())) return;

        String saved = prefs().getString(KEY_ADDRESS, null);
        // The box is left empty so the example address shows through as a hint.
        // Pre-filling it with "http://" hid the one thing a person needed to
        // see: the shape of what they are being asked for.
        if (saved != null) open(saved);
    }

    /**
     * The app was opened by a link — a station's code, scanned with the
     * phone's own camera. That link is the address, so remember it and go.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openFromIntent(intent);
    }

    private boolean openFromIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return false;
        Uri data = intent.getData();
        if (data == null) return false;

        String url = normalise(data.toString());
        remember(url);
        open(url);
        return true;
    }

    /** The station this device is bound to, or nothing on a fresh install. */
    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void remember(String url) {
        prefs().edit().putString(KEY_ADDRESS, normalise(url)).apply();
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

    private static String hostOf(String url) {
        try {
            return Uri.parse(url).getHost();
        } catch (Exception ignored) {
            return null;
        }
    }

    private boolean sameHost(String url) {
        String saved = prefs().getString(KEY_ADDRESS, null);
        if (saved == null) return false;
        String here = hostOf(url);
        String there = hostOf(saved);
        return here != null && here.equals(there);
    }

    private void open(String url) {
        setup.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        loadedHost = hostOf(url);
        web.loadUrl(url);

        /*
         * From here the device is a station, and a station has to keep
         * answering with its screen off. Android will not allow that without a
         * visible notification, and will not allow the notification on 13 and
         * up without being asked — so ask, once. Refusing costs the background
         * connection and nothing else.
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
               != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 12);
        }
        TerminalService.start(this, url);
    }

    /**
     * Back to the address form. After a failure it says why, in the words a
     * member of staff can act on: the device is off the restaurant's Wi-Fi, or
     * the computer behind the counter is switched off.
     */
    private void showSetup(boolean afterFailure) {
        web.setVisibility(View.GONE);
        setup.setVisibility(View.VISIBLE);
        address.setText(prefs().getString(KEY_ADDRESS, ""));
        title.setText(afterFailure ? R.string.unreachable_title : R.string.address_title);
        if (afterFailure) {
            Toast.makeText(this, R.string.unreachable_body, Toast.LENGTH_LONG).show();
        }
        // Not a station any more, so nothing to hold the radio awake for.
        TerminalService.stop(this);
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
            showSetup(false);
            return;
        }
        super.onBackPressed();
    }

    /**
     * The one thing this app hands the page, and the checks around it.
     *
     * Attached to the WebView, so it is reachable from any page the WebView
     * loads — which is why navigation is already restricted to the restaurant's
     * own host, and why this checks again anyway. Two mistakes have to line up
     * before a stranger's page could call it, rather than one.
     */
    private final class ClipboardBridge {

        @JavascriptInterface
        public String clipboardText() {
            String saved = prefs().getString(KEY_ADDRESS, null);
            String here = loadedHost;
            if (saved == null || here == null || !here.equals(hostOf(saved))) return "";

            ClipboardManager clipboard = getSystemService(ClipboardManager.class);
            if (clipboard == null || !clipboard.hasPrimaryClip()) return "";

            ClipData clip = clipboard.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";

            CharSequence text = clip.getItemAt(0).coerceToText(TerminalActivity.this);
            return text == null ? "" : text.toString();
        }
    }
}
