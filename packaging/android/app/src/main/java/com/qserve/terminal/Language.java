package com.qserve.terminal;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;

import java.util.Locale;

/**
 * The language this app is in, chosen on its own screen.
 *
 * Android's answer to "which language is this app in" is "whichever one the
 * phone is in", and for almost every app that is the right answer. It is not
 * the right answer here. A restaurant buys three second-hand tablets, and they
 * arrive in whatever language the last owner left them in; the phone in a
 * waiter's apron belongs to the waiter and is in theirs. Neither is a decision
 * the restaurant made, and neither is something a person about to set up a
 * station should have to go into Android settings to fix.
 *
 * So the three languages the product ships in are offered on the setup screen,
 * and the choice is remembered per device. Unchosen, the phone's own language
 * still wins — which is the right default, just not the only option.
 */
final class Language {

    private static final String PREFS = "qserve.terminal";
    private static final String KEY = "language";

    /** What the product ships. Anything else falls back to the phone's own. */
    static final String[] SUPPORTED = { "ar", "en", "tr" };

    private Language() { }

    /** The tag this device was set to, or null to follow the phone. */
    static String chosen(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
    }

    static void choose(Context context, String tag) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY, tag).apply();
    }

    /**
     * Wrap a context so its resources come back in the chosen language.
     *
     * Called from `attachBaseContext` in every activity and in the service, so
     * the choice reaches the notification text as well as the screens — a
     * station notification in English under an Arabic setup screen would be a
     * strange thing to leave behind.
     *
     * `setLayoutDirection` is the line that matters for Arabic: without it the
     * strings arrive in Arabic and the screen stays laid out left to right.
     */
    static Context apply(Context base) {
        String tag = chosen(base);
        if (tag == null) return base;

        boolean known = false;
        for (String supported : SUPPORTED) {
            if (supported.equals(tag)) known = true;
        }
        if (!known) return base;

        Locale locale = Locale.forLanguageTag(tag);
        Locale.setDefault(locale);

        Configuration configuration = new Configuration(base.getResources().getConfiguration());
        configuration.setLocale(locale);
        configuration.setLayoutDirection(locale);
        return base.createConfigurationContext(configuration);
    }
}
