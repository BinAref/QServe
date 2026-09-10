package com.qserve.terminal;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.util.AttributeSet;
import android.view.View;

/**
 * How many characters of the code have been typed, as dots.
 *
 * A masked text field shows the same thing, and shows it badly: the dots are
 * whatever size the font makes them, they sit wherever the text sits, and on a
 * short code they are a huddle in the middle of a wide box. A code is entered by
 * feel, glancing down — the only question is "how many have I pressed", and this
 * answers it at a size that can be read without looking properly.
 *
 * The code here can be 4 to 32 characters, so the row is not a fixed set of
 * slots that would be wrong for most codes. It grows: a dot appears as each
 * character is typed, and the newest one lands with a small spring rather than
 * simply existing, so a keypress is confirmed by the screen and not only by the
 * key.
 */
public class PinDots extends View {

    private static final int MAX_SHOWN = 12;

    private final Paint filled = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint empty = new Paint(Paint.ANTI_ALIAS_FLAG);

    private int count = 0;
    private float radius;
    private float gap;

    /** 0..1 while the newest dot is landing. */
    private float arriving = 1f;
    private ValueAnimator landing;

    private boolean wrong = false;

    public PinDots(Context context, AttributeSet attrs) {
        super(context, attrs);
        float density = getResources().getDisplayMetrics().density;
        radius = 7f * density;
        gap = 18f * density;

        filled.setStyle(Paint.Style.FILL);
        filled.setColor(getResources().getColor(R.color.primary, context.getTheme()));

        // The place a dot will be, drawn faintly. Without it the row jumps
        // around as it grows and there is nothing to aim the eye at.
        empty.setStyle(Paint.Style.FILL);
        empty.setColor(getResources().getColor(R.color.border_strong, context.getTheme()));
    }

    /** How many characters are in the field now. */
    public void setCount(int next) {
        if (next == count) return;
        boolean grew = next > count;
        count = Math.max(0, next);
        wrong = false;

        if (landing != null) landing.cancel();
        if (!grew) {
            arriving = 1f;
            invalidate();
            return;
        }

        landing = ValueAnimator.ofFloat(0f, 1f);
        landing.setDuration(160);
        landing.addUpdateListener(a -> {
            arriving = (float) a.getAnimatedValue();
            invalidate();
        });
        landing.start();
    }

    /** Paint the dots in the danger colour until the next keypress. */
    public void setWrong(boolean value) {
        wrong = value;
        filled.setColor(getResources().getColor(
            value ? R.color.danger : R.color.primary, getContext().getTheme()));
        invalidate();
    }

    public boolean isWrong() {
        return wrong;
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        // Four slots' worth of width even when empty, so the row does not
        // collapse to nothing before the first keypress.
        int slots = Math.max(4, Math.min(count + 1, MAX_SHOWN));
        int width = (int) (slots * gap);
        int height = (int) (radius * 4);
        setMeasuredDimension(resolveSize(width, widthSpec), resolveSize(height, heightSpec));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        int shown = Math.min(count, MAX_SHOWN);
        int slots = Math.max(4, Math.min(count + 1, MAX_SHOWN));

        float centreY = getHeight() / 2f;
        float totalWidth = (slots - 1) * gap;
        float startX = (getWidth() - totalWidth) / 2f;

        for (int i = 0; i < slots; i += 1) {
            float x = startX + i * gap;
            if (i < shown) {
                // The newest dot arrives at 1.6x and settles, which reads as a
                // press landing rather than a dot appearing.
                boolean newest = i == shown - 1;
                float scale = newest ? 1f + 0.6f * (1f - arriving) : 1f;
                canvas.drawCircle(x, centreY, radius * scale, filled);
            } else {
                canvas.drawCircle(x, centreY, radius * 0.45f, empty);
            }
        }
    }
}
