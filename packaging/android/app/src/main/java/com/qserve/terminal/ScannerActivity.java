package com.qserve.terminal;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.os.Bundle;
import android.util.Size;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.nio.ByteBuffer;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Reading a station's printed code.
 *
 * Every station in a restaurant — each table, the pass, the till — is a card
 * with a QR code on it, printed from the console. Until now, pointing this app
 * at one meant using the phone's own camera app and hoping it offered to open
 * the link here, which works on most phones, on some of them only after a
 * settings change, and on a tablet with no camera app at all not at all.
 *
 * So the app reads them itself. It is the whole of setting up a device: pick up
 * the card, point the phone, and the station opens.
 *
 * Nothing is stored and nothing is uploaded. Frames go from the camera to the
 * decoder and are dropped; the first thing that decodes to a QServe address
 * ends the activity and is handed back to {@link TerminalActivity}.
 */
public class ScannerActivity extends ComponentActivity {

    /** The scanned address, returned to the caller. */
    public static final String EXTRA_RESULT = "address";

    private static final int CAMERA_REQUEST = 11;

    private final AtomicBoolean claimed = new AtomicBoolean(false);
    private ExecutorService decoder;
    private PreviewView preview;

    /** Resources in the language this device was set to, not the phone's. */
    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(Language.apply(base));
    }

    @Override
    protected void onCreate(@Nullable Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_scanner);
        preview = findViewById(R.id.preview);

        findViewById(R.id.cancel).setOnClickListener(v -> {
            setResult(RESULT_CANCELED);
            finish();
        });

        decoder = Executors.newSingleThreadExecutor();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        } else {
            requestPermissions(new String[] { Manifest.permission.CAMERA }, CAMERA_REQUEST);
        }
    }

    @Override
    public void onRequestPermissionsResult(
        int code, @NonNull String[] permissions, @NonNull int[] granted) {
        super.onRequestPermissionsResult(code, permissions, granted);
        if (code != CAMERA_REQUEST) return;

        if (granted.length > 0 && granted[0] == PackageManager.PERMISSION_GRANTED) {
            startCamera();
            return;
        }
        // Refusing the camera is a legitimate answer, and the address can still
        // be typed. Say so and go back rather than sitting on a black screen.
        Toast.makeText(this, R.string.scan_no_camera, Toast.LENGTH_LONG).show();
        setResult(RESULT_CANCELED);
        finish();
    }

    private void startCamera() {
        TextView hint = findViewById(R.id.hint);
        hint.setVisibility(View.VISIBLE);

        var future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                ProcessCameraProvider provider = future.get();

                Preview shown = new Preview.Builder().build();
                shown.setSurfaceProvider(preview.getSurfaceProvider());

                /*
                 * 1280x720 is the smallest resolution that reliably resolves a
                 * table card held at arm's length, and small enough that an old
                 * tablet decodes every frame rather than falling behind. Keeping
                 * only the latest frame matters more than the size: a queue of
                 * stale frames means the code is read from where the phone was
                 * pointing a second ago.
                 */
                ImageAnalysis analysis = new ImageAnalysis.Builder()
                    .setTargetResolution(new Size(1280, 720))
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build();
                analysis.setAnalyzer(decoder, this::examine);

                provider.unbindAll();
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, shown, analysis);
            } catch (Exception failure) {
                Toast.makeText(this, R.string.scan_failed, Toast.LENGTH_LONG).show();
                setResult(RESULT_CANCELED);
                finish();
            }
        }, ContextCompat.getMainExecutor(this));
    }

    /** One frame. Decoded on the camera's own thread, and always closed. */
    private void examine(@NonNull ImageProxy frame) {
        try {
            if (claimed.get()) return;
            if (frame.getFormat() != ImageFormat.YUV_420_888) return;

            String text = decode(frame);
            if (text == null) return;

            // A code is read many times a second; only the first one counts.
            if (!claimed.compareAndSet(false, true)) return;
            runOnUiThread(() -> {
                setResult(RESULT_OK, getIntent().putExtra(EXTRA_RESULT, text));
                finish();
            });
        } finally {
            // Not closing a frame stops the camera dead after a handful of them.
            frame.close();
        }
    }

    /**
     * The luminance plane is all a QR decoder needs, and it is the first plane
     * of a YUV frame — so the colour planes are never touched and nothing is
     * converted. On a slow tablet that is the difference between reading a card
     * as it comes into view and reading it a second later.
     */
    @Nullable
    private String decode(@NonNull ImageProxy frame) {
        ByteBuffer buffer = frame.getPlanes()[0].getBuffer();
        byte[] luminance = new byte[buffer.remaining()];
        buffer.get(luminance);

        int rowStride = frame.getPlanes()[0].getRowStride();
        int width = frame.getWidth();
        int height = frame.getHeight();
        // Some cameras pad each row. The stride is the real width of the buffer;
        // using the image width instead shears the picture and nothing decodes.
        int stride = rowStride > 0 ? rowStride : width;
        if (stride * height > luminance.length) return null;

        PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
            luminance, stride, height, 0, 0, width, height, false);

        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        // Slower per frame, and worth it: a card at an angle under a heat lamp
        // is the normal case, not the exception.
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);

        try {
            Result result = new QRCodeReader()
                .decode(new BinaryBitmap(new HybridBinarizer(source)), hints);
            String text = result.getText();
            return text == null || text.isEmpty() ? null : text;
        } catch (Exception notThisFrame) {
            // Most frames have no code in them. That is not an error.
            return null;
        }
    }

    @Override
    protected void onDestroy() {
        if (decoder != null) decoder.shutdown();
        super.onDestroy();
    }
}
