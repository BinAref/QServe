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
import android.app.AlertDialog;
import android.os.Bundle;
import android.text.InputFilter;
import android.text.InputType;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.animation.Animation;
import android.view.animation.AnimationUtils;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.annotation.Nullable;
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

    /**
     * Set when the activity restarts itself after a language change, so that a
     * device which already knows its station stays on the setup screen instead
     * of being thrown back into the WebView the moment the language is picked.
     */
    private static final String EXTRA_SHOW_SETUP = "show_setup";

    /** The lock screen, answered before anything behind it is drawn. */
    private static final int UNLOCK_REQUEST = 21;

    private WebView web;
    private View setup;
    private EditText address;
    private TextView title;
    private View clearButton;

    /**
     * The host of the page currently loaded, kept on this side so the clipboard
     * bridge can check it without touching the WebView from another thread.
     */
    private volatile String loadedHost;

    private ActivityResultLauncher<Intent> scanner;

    /** Resources in the language this device was set to, not the phone's. */
    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(Appearance.apply(base));
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Before the guard below can ask for a code, in case this build ships one.
        AppLock.seedFromBuild(this, BuildConfig.VENDOR_CODE);
        setContentView(R.layout.activity_terminal);

        web = findViewById(R.id.web);
        setup = findViewById(R.id.setup);
        address = findViewById(R.id.address);
        title = findViewById(R.id.title);
        Button connect = findViewById(R.id.connect);
        Button scan = findViewById(R.id.scan);

        wireFieldActions();
        wireAppearance();
        arrive();

        /*
         * The vendor's build has no station codes to read: its server issues
         * licences, it does not print QR cards. Offering a camera button that
         * can only ever fail is worse than offering nothing.
         */
        if (BuildConfig.BUILD_FOR_VENDOR) {
            scan.setVisibility(View.GONE);
            // "or type it" with nothing above it to be an alternative to.
            findViewById(R.id.or_divider).setVisibility(View.GONE);
        }

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
        web.setBackgroundColor(getResources().getColor(R.color.background, getTheme()));

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
        /*
         * Keep the sign-in across a close.
         *
         * The vendor console hands out a session cookie with a twelve-hour life
         * — a real expiry, not a session cookie — so it is meant to outlive the
         * window it was issued in. A WebView holds cookies in memory and only
         * writes them out when asked, so without the flush below a vendor would
         * be signing in again every time they came back to the app, which is
         * not what the server intended and not what anybody wants.
         */
        android.webkit.CookieManager cookies = android.webkit.CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);

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

        scan.setOnClickListener(v -> {
            scanner.launch(new Intent(this, ScannerActivity.class));
            overridePendingTransition(R.anim.fade_in, R.anim.fade_out);
        });

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

        // Nothing behind the lock is drawn until it is answered.
        if (LockActivity.guard(this, UNLOCK_REQUEST)) return;

        openWhatWeKnow();
    }

    /** Once past the lock, if there is one: a scanned code, or what was saved. */
    private void openWhatWeKnow() {
        // A scanned code wins over anything remembered: somebody pointing a
        // camera at a station's code is telling this device where it belongs.
        if (openFromIntent(getIntent())) return;

        // Just came back from picking a language: stay where they were.
        if (getIntent() != null && getIntent().getBooleanExtra(EXTRA_SHOW_SETUP, false)) {
            address.setText(prefs().getString(KEY_ADDRESS, ""));
            return;
        }

        /*
         * A build that was told where it belongs goes there.
         *
         * The vendor has one licence server, so the address screen would be a
         * question with one answer. Remembered like a typed one, so "point at a
         * different server" still works and still sticks.
         */
        if (prefs().getString(KEY_ADDRESS, null) == null
            && !BuildConfig.VENDOR_URL.isEmpty()) {
            remember(BuildConfig.VENDOR_URL);
        }

        String saved = prefs().getString(KEY_ADDRESS, null);
        // The box is left empty so the example address shows through as a hint.
        // Pre-filling it with "http://" hid the one thing a person needed to
        // see: the shape of what they are being asked for.
        if (saved != null) open(saved);
    }

    /**
     * The setup screen, arriving rather than being there.
     *
     * Each block starts a little after the one above it, so the eye is led from
     * the mark down to the action instead of meeting the whole screen at once.
     * The whole cascade is under half a second; past that it stops being a
     * screen appearing and becomes a screen somebody is waiting for.
     *
     * Android scales every animation by the device's own animator duration —
     * zero on a phone whose owner has turned animation off in accessibility
     * settings — so this needs no switch of its own to respect that.
     */
    private void arrive() {
        ViewGroup column = (ViewGroup) ((ViewGroup) setup).getChildAt(0);
        for (int i = 0; i < column.getChildCount(); i += 1) {
            Animation rise = AnimationUtils.loadAnimation(this, R.anim.rise_in);
            // Capped, so a screen that grows a row does not grow a longer wait.
            rise.setStartOffset(Math.min(i, 5) * 55L);
            column.getChildAt(i).startAnimation(rise);
        }
    }

    /**
     * Paste and clear, inside the address box.
     *
     * The same pair the product puts in every field on every screen, for the
     * same reason: this box is filled by pasting an address somebody sent, on a
     * phone, and clearing it by hand means a long press, a magnifier and a
     * drag. Clear appears only when there is something to clear, so the button
     * showing up is itself the signal that the box is not empty.
     */
    private void wireFieldActions() {
        View paste = findViewById(R.id.paste);
        clearButton = findViewById(R.id.clear);

        paste.setOnClickListener(v -> {
            ClipboardManager clipboard = getSystemService(ClipboardManager.class);
            ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
            CharSequence text = clip == null || clip.getItemCount() == 0
                ? null : clip.getItemAt(0).coerceToText(this);

            if (text == null || text.toString().trim().isEmpty()) {
                Toast.makeText(this, R.string.clipboard_empty, Toast.LENGTH_SHORT).show();
                return;
            }
            // Replacing rather than appending: there is one address, and a
            // half-typed one plus a pasted one is not a third address.
            address.setText(text.toString().trim());
            address.setSelection(address.getText().length());
        });

        clearButton.setOnClickListener(v -> {
            address.setText("");
            address.requestFocus();
        });

        address.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { syncClear(); }
        });
        syncClear();
    }

    private void syncClear() {
        clearButton.setVisibility(address.getText().length() == 0 ? View.GONE : View.VISIBLE);
    }

    /**
     * The two dropdowns at the foot of the screen.
     *
     * Picking either restarts the screen: a language and a night mode are
     * applied when resources are attached, and there is no way to re-attach
     * them under a running activity.
     */
    private void wireAppearance() {
        dropdown(findViewById(R.id.language), Appearance.LANGUAGES,
            Appearance.language(this), this::languageName, chosen -> {
                Appearance.setLanguage(this, chosen);
                restart();
            });

        dropdown(findViewById(R.id.theme), Appearance.THEMES,
            Appearance.theme(this), this::themeName, chosen -> {
                Appearance.setTheme(this, chosen);
                restart();
            });
    }

    /** A name for a language, written in that language and never translated. */
    private String languageName(String value) {
        switch (value) {
            case "ar": return getString(R.string.language_ar);
            case "en": return getString(R.string.language_en);
            case "tr": return getString(R.string.language_tr);
            default: return getString(R.string.follow_device);
        }
    }

    private String themeName(String value) {
        switch (value) {
            case Appearance.LIGHT: return getString(R.string.theme_light);
            case Appearance.DARK: return getString(R.string.theme_dark);
            default: return getString(R.string.follow_device);
        }
    }

    /**
     * Turn a label into a dropdown over a fixed set of values.
     *
     * A PopupMenu rather than a Spinner: a Spinner brings its own idea of what
     * a control looks like, and this screen has a look already.
     */
    private void dropdown(
        TextView label, String[] values, String current,
        java.util.function.Function<String, String> naming,
        java.util.function.Consumer<String> onPick) {

        label.setText(naming.apply(current));
        ownChevron(label);
        label.setOnClickListener(v -> {
            // The chevron turns over while the menu is open: a control that
            // shows its own state needs no second affordance beside it.
            turnChevron(label, true);
            PopupMenu menu = new PopupMenu(this, label);
            menu.setOnDismissListener(m -> turnChevron(label, false));
            for (int i = 0; i < values.length; i += 1) {
                menu.getMenu().add(0, i, i, naming.apply(values[i]));
            }
            menu.setOnMenuItemClickListener(item -> {
                String picked = values[item.getItemId()];
                if (picked.equals(current)) return true;
                onPick.accept(picked);
                return true;
            });
            menu.show();
        });
    }

    /**
     * A dialog with one box in it.
     *
     * Deliberately not a "confirm the code" second box: a code short enough to
     * type one-handed is short enough to read back, and the person setting it is
     * the person who will type it next.
     */
    private void askForNewCode() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        input.setHint(R.string.lock_hint);
        input.setFilters(new InputFilter[] { new InputFilter.LengthFilter(AppLock.MAX_LENGTH) });

        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        FrameLayout frame = new FrameLayout(this);
        frame.setPadding(pad, pad / 2, pad, 0);
        frame.addView(input);

        new AlertDialog.Builder(this)
            .setTitle(R.string.app_lock)
            .setMessage(R.string.app_lock_hint)
            .setView(frame)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.save, (dialog, which) -> {
                String code = input.getText().toString();
                if (code.length() < AppLock.MIN_LENGTH) {
                    Toast.makeText(this, R.string.app_lock_too_short, Toast.LENGTH_LONG).show();
                    return;
                }
                AppLock.set(this, code);
                Toast.makeText(this, R.string.app_lock_saved, Toast.LENGTH_SHORT).show();
            })
            .show();
    }

    /** The lock screen answered — or backed out of, which closes the app. */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != UNLOCK_REQUEST) return;
        if (resultCode == RESULT_OK) openWhatWeKnow();
        else finishAffinity();
    }

    /**
     * Turn a dropdown's chevron over while its menu is open.
     *
     * The drawable is rotated rather than swapped for a second icon, so there
     * is one chevron in the project and the halfway frames exist.
     */
    /**
     * Give this label's chevron a state of its own.
     *
     * Drawables loaded from the same resource share a ConstantState, so a level
     * set on one is set on every one — which showed as all three chevrons
     * turning over when a single dropdown opened.  breaks the sharing,
     * and the result has to be set back on the view to take effect.
     */
    private void ownChevron(TextView label) {
        android.graphics.drawable.Drawable[] all = label.getCompoundDrawablesRelative();
        if (all[2] == null) return;
        label.setCompoundDrawablesRelativeWithIntrinsicBounds(
            all[0], all[1], all[2].mutate(), all[3]);
    }

    private void turnChevron(TextView label, boolean open) {
        android.graphics.drawable.Drawable[] all = label.getCompoundDrawablesRelative();
        android.graphics.drawable.Drawable chevron = all[2];
        if (chevron == null) return;

        android.animation.ValueAnimator turn = android.animation.ValueAnimator.ofFloat(
            open ? 0f : 180f, open ? 180f : 0f);
        turn.setDuration(180);
        turn.addUpdateListener(a -> {
            // Level is 0..10000 over a full turn; the drawable is wrapped in a
            // rotate so the level drives the angle.
            float degrees = (float) a.getAnimatedValue();
            chevron.setLevel((int) (degrees / 360f * 10000f));
        });
        turn.start();
    }

    /** Draw this screen again under the new language or theme. */
    private void restart() {
        Intent again = new Intent(this, TerminalActivity.class);
        again.putExtra(EXTRA_SHOW_SETUP, true);
        again.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        finish();
        startActivity(again);
        // The same screen in another language or another shade, so it dissolves
        // rather than sliding in from somewhere it did not come from.
        overridePendingTransition(R.anim.fade_in, R.anim.fade_out);
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

    /**
     * Where a typed address actually leads.
     *
     * The licence server answers its console at /admin and redirects / to it,
     * so a bare address works — but only by a redirect, and only for the root.
     * Asking for the console outright means a vendor who typed an address with
     * a path on the end still lands on the console rather than on whatever
     * they typed.
     */
    private String consoleUrl(String base) {
        if (!BuildConfig.BUILD_FOR_VENDOR) return base;
        return base.endsWith("/admin") ? base : base + "/admin";
    }

    private void open(String url) {
        setup.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        loadedHost = hostOf(url);
        web.loadUrl(consoleUrl(url));

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

    /** Written to disk here, because a process can be killed without warning. */
    @Override
    protected void onPause() {
        super.onPause();
        android.webkit.CookieManager.getInstance().flush();
    }

    @Override
    public void onBackPressed() {
        // Back inside the restaurant's own pages behaves as it does in a
        // browser; back at the first page opens this station's own menu rather
        // than dropping a member of staff onto their home screen mid-service.
        if (web.getVisibility() == View.VISIBLE && web.canGoBack()) {
            web.goBack();
            return;
        }
        if (web.getVisibility() == View.VISIBLE) {
            openStationMenu();
            return;
        }
        super.onBackPressed();
    }

    /**
     * The app's own settings, from inside the app.
     *
     * These used to live only on the address screen, which is a screen a device
     * passes through once and then never sees again — so setting a lock code
     * meant signing out of the thing you wanted to lock. They are on the back
     * press now, which is the one gesture everybody already knows, and nothing
     * floats over the restaurant's own pages to get at them.
     */
    private void openStationMenu() {
        boolean locked = AppLock.isSet(this);

        CharSequence[] choices = {
            getString(locked ? R.string.app_lock_change : R.string.app_lock_set),
            getString(R.string.app_lock_remove),
            getString(R.string.language),
            getString(R.string.theme),
            getString(R.string.sign_out),
            getString(R.string.change_address),
        };
        // Removing a lock that is not set is not an option worth offering.
        boolean[] shown = { true, locked, true, true, true, true };

        java.util.List<CharSequence> visible = new java.util.ArrayList<>();
        java.util.List<Integer> actions = new java.util.ArrayList<>();
        for (int i = 0; i < choices.length; i += 1) {
            if (!shown[i]) continue;
            visible.add(choices[i]);
            actions.add(i);
        }

        new AlertDialog.Builder(this)
            .setTitle(R.string.station_menu)
            .setItems(visible.toArray(new CharSequence[0]), (dialog, which) -> {
                switch (actions.get(which)) {
                    case 0 -> askForNewCode();
                    case 1 -> {
                        AppLock.set(this, null);
                        Toast.makeText(this, R.string.app_lock_removed, Toast.LENGTH_SHORT).show();
                    }
                    case 2 -> pickFrom(Appearance.LANGUAGES, Appearance.language(this),
                        this::languageName, chosen -> {
                            Appearance.setLanguage(this, chosen);
                            restart();
                        });
                    case 3 -> pickFrom(Appearance.THEMES, Appearance.theme(this),
                        this::themeName, chosen -> {
                            Appearance.setTheme(this, chosen);
                            restart();
                        });
                    case 4 -> signOut();
                    case 5 -> showSetup(false);
                    default -> { }
                }
            })
            .setNegativeButton(R.string.stay_here, null)
            .show();
    }

    /** The same list a dropdown offers, as a dialog, for use away from one. */
    private void pickFrom(
        String[] values, String current,
        java.util.function.Function<String, String> naming,
        java.util.function.Consumer<String> onPick) {

        CharSequence[] names = new CharSequence[values.length];
        int checked = 0;
        for (int i = 0; i < values.length; i += 1) {
            names[i] = naming.apply(values[i]);
            if (values[i].equals(current)) checked = i;
        }
        new AlertDialog.Builder(this)
            .setSingleChoiceItems(names, checked, (dialog, which) -> {
                dialog.dismiss();
                if (!values[which].equals(current)) onPick.accept(values[which]);
            })
            .show();
    }

    /**
     * Forget who this device was signed in as, and go back to the address.
     *
     * The session lives in a cookie the server set, so signing out means
     * clearing cookies rather than telling the page to — a page that has already
     * failed to load cannot be asked to sign anything out. The address itself is
     * kept: signing out of a station is not the same as forgetting where it is.
     */
    private void signOut() {
        android.webkit.CookieManager cookies = android.webkit.CookieManager.getInstance();
        cookies.removeAllCookies(ignored -> cookies.flush());
        web.clearHistory();
        web.loadUrl("about:blank");
        showSetup(false);
        Toast.makeText(this, R.string.signed_out, Toast.LENGTH_SHORT).show();
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
