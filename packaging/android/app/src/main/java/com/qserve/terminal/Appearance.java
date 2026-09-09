package com.qserve.terminal;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;

import java.util.Locale;

/**
 * What language this app is in, and whether it is light or dark.
 *
 * Both default to the device and both can be overridden here, for the same
 * reason. A restaurant buys three second-hand tablets and they arrive in
 * whatever language and whatever theme the last owner left them in; the phone in
 * a waiter's apron belongs to the waiter. Following the device is the right
 * default — it is what everything else on that device does — but it cannot be
 * the only option, because a member of staff should not have to go into Android
 * settings before a station can be set up.
 *
 * Both are applied in one place, `attachBaseContext`, which every activity and
 * the service call. That is what makes the choice reach the whole app rather
 * than the one screen it was made on — the scanner, the toasts, the station
 * notification — and it is why nothing else in the app reads either setting.
 */
final class Appearance {

    private static final String PREFS = "qserve.terminal";
    private static final String KEY_LANGUAGE = "language";
    private static final String KEY_THEME = "theme";

    /** Follow the device. The default for both, and the first option in both. */
    static final String SYSTEM = "system";

    static final String LIGHT = "light";
    static final String DARK = "dark";

    /**
     * The languages the product ships. A device set to anything else — French,
     * Urdu, the tablet that came in Korean — gets English, because that is what
     * `res/values/` holds and what Android falls back to when it has no better
     * match. That fallback is the behaviour, not an accident of it.
     */
    static final String[] LANGUAGES = { SYSTEM, "ar", "en", "tr" };
    static final String[] THEMES = { SYSTEM, LIGHT, DARK };

    private Appearance() { }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String language(Context context) {
        return prefs(context).getString(KEY_LANGUAGE, SYSTEM);
    }

    static String theme(Context context) {
        return prefs(context).getString(KEY_THEME, SYSTEM);
    }

    static void setLanguage(Context context, String value) {
        prefs(context).edit().putString(KEY_LANGUAGE, value).apply();
    }

    static void setTheme(Context context, String value) {
        prefs(context).edit().putString(KEY_THEME, value).apply();
    }

    /**
     * Wrap a context so its resources answer in the chosen language and theme.
     *
     * Neither is applied unless it was chosen: left alone, the configuration is
     * the device's own and Android picks `values-night/` and the locale exactly
     * as it does for every other app.
     *
     * `setLayoutDirection` is the line that matters for Arabic. Without it the
     * strings come back in Arabic and the screen stays laid out left to right,
     * which is worse than either language on its own.
     */
    static Context apply(Context base) {
        Configuration configuration = new Configuration(base.getResources().getConfiguration());
        boolean overridden = false;

        String language = language(base);
        if (!SYSTEM.equals(language) && supported(LANGUAGES, language)) {
            Locale locale = Locale.forLanguageTag(language);
            Locale.setDefault(locale);
            configuration.setLocale(locale);
            configuration.setLayoutDirection(locale);
            overridden = true;
        }

        String theme = theme(base);
        if (LIGHT.equals(theme) || DARK.equals(theme)) {
            int night = DARK.equals(theme)
                ? Configuration.UI_MODE_NIGHT_YES
                : Configuration.UI_MODE_NIGHT_NO;
            configuration.uiMode =
                (configuration.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | night;
            overridden = true;
        }

        return overridden ? base.createConfigurationContext(configuration) : base;
    }

    private static boolean supported(String[] values, String value) {
        for (String candidate : values) {
            if (candidate.equals(value)) return true;
        }
        return false;
    }
}
