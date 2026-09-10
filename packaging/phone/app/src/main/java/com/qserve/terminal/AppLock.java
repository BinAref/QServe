package com.qserve.terminal;

import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * A code that has to be entered before this app opens.
 *
 * It matters most on the vendor's phone. That app can issue licences — the
 * thing the whole product is sold on — and a phone is left on a counter, handed
 * to somebody to look at a photo, or lost in a taxi. A lock screen is not
 * security against somebody who takes the phone apart, and does not pretend to
 * be; it is the difference between an unlocked app and a locked one for anybody
 * who simply picks it up.
 *
 * The code is never stored. What is stored is a salted SHA-256 of it, and the
 * comparison is constant-time — not because a four-digit code has meaningful
 * entropy against an attacker who already has the file, but because writing the
 * careless version of this is how the careless version ends up somewhere it
 * matters.
 */
final class AppLock {

    private static final String PREFS = "qserve.terminal";
    private static final String KEY_HASH = "lock.hash";
    private static final String KEY_SALT = "lock.salt";

    /** Short enough to type one-handed, long enough not to be guessed by a shrug. */
    static final int MIN_LENGTH = 4;
    static final int MAX_LENGTH = 32;

    private AppLock() { }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isSet(Context context) {
        return prefs(context).getString(KEY_HASH, null) != null;
    }

    /** Set or replace the code. Passing null removes the lock. */
    static void set(Context context, String code) {
        SharedPreferences.Editor editor = prefs(context).edit();
        if (code == null || code.isEmpty()) {
            editor.remove(KEY_HASH).remove(KEY_SALT).apply();
            return;
        }
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        String encodedSalt = Base64.getEncoder().encodeToString(salt);
        editor.putString(KEY_SALT, encodedSalt)
            .putString(KEY_HASH, hash(code, encodedSalt))
            .apply();
    }

    static boolean matches(Context context, String code) {
        String stored = prefs(context).getString(KEY_HASH, null);
        String salt = prefs(context).getString(KEY_SALT, null);
        if (stored == null || salt == null || code == null) return false;
        return constantTimeEquals(stored, hash(code, salt));
    }

    private static String hash(String code, String salt) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(salt.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) ':');
            return Base64.getEncoder().encodeToString(
                digest.digest(code.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception impossible) {
            // SHA-256 is required of every Android platform. If it is missing,
            // failing closed is the only honest answer.
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    /** Compares every character regardless of where the first difference is. */
    private static boolean constantTimeEquals(String a, String b) {
        byte[] left = a.getBytes(StandardCharsets.UTF_8);
        byte[] right = b.getBytes(StandardCharsets.UTF_8);
        if (left.length != right.length) return false;
        int difference = 0;
        for (int i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
        return difference == 0;
    }
}
