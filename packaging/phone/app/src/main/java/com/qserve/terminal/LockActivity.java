package com.qserve.terminal;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
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
 * it to whoever swipes up.
 */
public class LockActivity extends ComponentActivity {

    /** Set when this is a fresh unlock rather than a first-run set-up. */
    private static final int WRONG_BEFORE_PAUSE = 5;

    private int wrong = 0;

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

        EditText code = findViewById(R.id.code);
        Button unlock = findViewById(R.id.unlock);
        TextView error = findViewById(R.id.error);

        unlock.setOnClickListener(v -> {
            if (wrong >= WRONG_BEFORE_PAUSE) return;

            if (AppLock.matches(this, code.getText().toString())) {
                setResult(RESULT_OK);
                finish();
                overridePendingTransition(0, 0);
                return;
            }

            wrong += 1;
            code.setText("");
            error.setVisibility(View.VISIBLE);

            /*
             * Five wrong tries and the button stops answering for a while.
             *
             * Not a serious defence — somebody holding the phone can restart the
             * app — but it is the difference between a four-digit code somebody
             * guesses while standing there and one they do not.
             */
            if (wrong >= WRONG_BEFORE_PAUSE) {
                unlock.setEnabled(false);
                error.setText(R.string.lock_too_many);
                unlock.postDelayed(() -> {
                    wrong = 0;
                    unlock.setEnabled(true);
                    error.setText(R.string.lock_wrong);
                    error.setVisibility(View.INVISIBLE);
                }, 30_000);
            }
        });

        code.setOnEditorActionListener((v, actionId, event) -> {
            unlock.performClick();
            return true;
        });
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
        return true;
    }
}
