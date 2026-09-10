package com.qserve.terminal;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.AnimationUtils;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.activity.ComponentActivity;

/**
 * The code, asked for before anything else is shown.
 *
 * Shown at launch whenever one is set, and nothing behind it is drawn first —
 * the station is not loaded, the address is not shown, and on the vendor's build
 * the licence console is not opened. Backing out closes the app rather than
 * dropping through, because a lock somebody can walk past is decoration.
 *
 * `FLAG_SECURE` keeps this screen out of the task switcher's thumbnail and out
 * of screenshots, which is where a lock screen otherwise leaks the thing behind
 * it to whoever swipes up. It also means this screen cannot be screenshotted for
 * a bug report, which is the trade and the right way round.
 */
public class LockActivity extends ComponentActivity {

    private static final int WRONG_BEFORE_PAUSE = 5;
    private static final long PAUSE_MILLIS = 30_000;

    private int wrong = 0;

    private EditText code;
    private PinDots dots;
    private TextView error;
    private Button unlock;

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(Appearance.apply(base));
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        // No thumbnail of this screen in the task switcher, and no screenshots.
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);

        setContentView(R.layout.activity_lock);

        code = findViewById(R.id.code);
        dots = findViewById(R.id.dots);
        error = findViewById(R.id.error);
        unlock = findViewById(R.id.unlock);
        ImageView mark = findViewById(R.id.mark);

        // The panel arrives rather than being there. Two hundred milliseconds
        // of it, which is under the threshold at which waiting is noticed.
        findViewById(R.id.panel).startAnimation(
            AnimationUtils.loadAnimation(this, R.anim.rise_in));

        /*
         * The whole screen is one tap target for the keyboard. A person who has
         * dismissed it should not have to find a one-pixel field to get it back.
         */
        View.OnClickListener focus = v -> {
            code.requestFocus();
            InputMethodManager keyboard = getSystemService(InputMethodManager.class);
            if (keyboard != null) keyboard.showSoftInput(code, InputMethodManager.SHOW_IMPLICIT);
        };
        findViewById(R.id.panel).setOnClickListener(focus);
        dots.setOnClickListener(focus);
        mark.setOnClickListener(focus);

        code.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }

            @Override
            public void afterTextChanged(Editable s) {
                dots.setCount(s.length());
                // The refusal clears itself the moment they start again, so it
                // is never left standing over a code that has been retyped.
                if (error.getVisibility() == View.VISIBLE) {
                    error.setVisibility(View.INVISIBLE);
                    dots.setWrong(false);
                }
            }
        });

        unlock.setOnClickListener(v -> attempt());
        code.setOnEditorActionListener((v, actionId, event) -> {
            attempt();
            return true;
        });

        code.postDelayed(() -> focus.onClick(code), 220);
    }

    private void attempt() {
        if (!unlock.isEnabled()) return;

        if (AppLock.matches(this, code.getText().toString())) {
            setResult(RESULT_OK);
            finish();
            // No slide out: what is behind this was already there.
            overridePendingTransition(R.anim.fade_in, R.anim.fade_out);
            return;
        }

        wrong += 1;
        code.setText("");
        dots.setCount(0);
        dots.setWrong(true);
        error.setText(R.string.lock_wrong);
        error.setVisibility(View.VISIBLE);
        dots.startAnimation(AnimationUtils.loadAnimation(this, R.anim.shake));

        /*
         * Five wrong tries and the button stops answering for half a minute.
         *
         * Not a serious defence — somebody holding the phone can restart the app
         * — but it is the difference between a four-digit code guessed while
         * standing there and one that is not.
         */
        if (wrong >= WRONG_BEFORE_PAUSE) {
            unlock.setEnabled(false);
            unlock.setAlpha(0.5f);
            error.setText(R.string.lock_too_many);
            unlock.postDelayed(() -> {
                wrong = 0;
                unlock.setEnabled(true);
                unlock.animate().alpha(1f).setDuration(180).start();
                error.setVisibility(View.INVISIBLE);
                dots.setWrong(false);
            }, PAUSE_MILLIS);
        }
    }

    /** Back out of a lock screen and the app closes; it does not fall through. */
    @Override
    public void onBackPressed() {
        finishAffinity();
    }

    /** Ask for the code, if one is set. Returns true when the caller should wait. */
    static boolean guard(ComponentActivity activity, int requestCode) {
        if (!AppLock.isSet(activity)) return false;
        activity.startActivityForResult(new Intent(activity, LockActivity.class), requestCode);
        activity.overridePendingTransition(R.anim.fade_in, R.anim.fade_out);
        return true;
    }
}
