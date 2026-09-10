package com.qserve.terminal;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.AccelerateDecelerateInterpolator;

/**
 * The frame drawn over the camera while a station code is being read.
 *
 * The scanner deliberately had none of this: the decoder reads the whole frame,
 * so a cut-out would suggest the code has to be lined up inside it when it does
 * not, and somebody holding a table card at arm's length should not also be
 * solving an aiming puzzle.
 *
 * That reasoning was right about the decoder and wrong about the person. A
 * camera preview with nothing on it gives no sign that anything is happening —
 * no way to tell a scanner that is working from one that has frozen, and nowhere
 * for the eye to rest. So there is a frame, and the rule it was avoiding is kept
 * instead by what the frame does: the surround is dimmed rather than masked, the
 * corners are open rather than a closed box, and a code read anywhere in the
 * picture is still a code read. It aims without demanding.
 *
 * The line sweeping down it is the only part that is purely a signal that the
 * scanner is alive — and it is worth its pixels for exactly that reason.
 */
public class Viewfinder extends View {

    private final Paint dim = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint corner = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint sweep = new Paint(Paint.ANTI_ALIAS_FLAG);

    private final RectF window = new RectF();
    private final Path cut = new Path();

    private final float density;
    private float progress = 0f;
    private ValueAnimator sweeping;

    public Viewfinder(Context context, AttributeSet attrs) {
        super(context, attrs);
        density = getResources().getDisplayMetrics().density;

        dim.setColor(Color.parseColor("#A6000000"));

        corner.setStyle(Paint.Style.STROKE);
        corner.setStrokeWidth(4f * density);
        corner.setStrokeCap(Paint.Cap.ROUND);
        corner.setColor(getResources().getColor(R.color.primary, context.getTheme()));

        sweep.setStyle(Paint.Style.FILL);

        setLayerType(LAYER_TYPE_HARDWARE, null);
    }

    @Override
    protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);

        // A square, three quarters of the narrow side, sitting a little above
        // centre — where a phone held at reading height actually points.
        float side = Math.min(width, height) * 0.72f;
        float left = (width - side) / 2f;
        float top = (height - side) / 2f - height * 0.06f;
        window.set(left, top, left + side, top + side);

        sweep.setShader(new LinearGradient(
            0, 0, 0, 40f * density,
            new int[] { 0x00000000, corner.getColor(), 0x00000000 },
            null, Shader.TileMode.CLAMP));

        startSweeping();
    }

    private void startSweeping() {
        if (sweeping != null) sweeping.cancel();
        sweeping = ValueAnimator.ofFloat(0f, 1f);
        sweeping.setDuration(2200);
        sweeping.setRepeatCount(ValueAnimator.INFINITE);
        sweeping.setRepeatMode(ValueAnimator.REVERSE);
        sweeping.setInterpolator(new AccelerateDecelerateInterpolator());
        sweeping.addUpdateListener(a -> {
            progress = (float) a.getAnimatedValue();
            invalidate();
        });
        sweeping.start();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float radius = 22f * density;

        /*
         * Dim everything outside the window rather than mask it.
         *
         * The difference matters: a mask says the code must be inside, and it
         * need not be. Dimming says "look here", which is true.
         */
        cut.reset();
        cut.addRoundRect(window, radius, radius, Path.Direction.CW);
        canvas.save();
        canvas.clipOutPath(cut);
        canvas.drawPaint(dim);
        canvas.restore();

        // Open corners, not a closed frame — for the same reason.
        float arm = 30f * density;
        Path brackets = new Path();

        brackets.moveTo(window.left, window.top + arm);
        brackets.lineTo(window.left, window.top + radius);
        brackets.quadTo(window.left, window.top, window.left + radius, window.top);
        brackets.lineTo(window.left + arm, window.top);

        brackets.moveTo(window.right - arm, window.top);
        brackets.lineTo(window.right - radius, window.top);
        brackets.quadTo(window.right, window.top, window.right, window.top + radius);
        brackets.lineTo(window.right, window.top + arm);

        brackets.moveTo(window.right, window.bottom - arm);
        brackets.lineTo(window.right, window.bottom - radius);
        brackets.quadTo(window.right, window.bottom, window.right - radius, window.bottom);
        brackets.lineTo(window.right - arm, window.bottom);

        brackets.moveTo(window.left + arm, window.bottom);
        brackets.lineTo(window.left + radius, window.bottom);
        brackets.quadTo(window.left, window.bottom, window.left, window.bottom - radius);
        brackets.lineTo(window.left, window.bottom - arm);

        canvas.drawPath(brackets, corner);

        // The line. Clipped to the window so it never runs over the corners.
        canvas.save();
        canvas.clipPath(cut);
        float inset = 24f * density;
        float y = window.top + inset + (window.height() - inset * 2) * progress;
        canvas.translate(0, y - 20f * density);
        canvas.drawRect(window.left, 0, window.right, 40f * density, sweep);
        canvas.restore();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (sweeping != null) sweeping.cancel();
        super.onDetachedFromWindow();
    }
}
