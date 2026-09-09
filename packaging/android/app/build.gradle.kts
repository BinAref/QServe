plugins {
    id("com.android.application")
}

android {
    namespace = "com.qserve.terminal"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.qserve.terminal"
        // Android 8 and up: the adaptive launcher icon is one vector rather
        // than five bitmaps, and every tablet a restaurant is likely to buy
        // second-hand today is past it.
        minSdk = 26
        targetSdk = 35
        versionCode = 8
        versionName = "1.0.7"
    }

    buildTypes {
        release {
            // No shrinking: there is almost no code here, and an obfuscated
            // WebView shell is harder to audit for no benefit.
            isMinifyEnabled = false
            // Signed with the debug key unless a release keystore is supplied,
            // so a build from a clean checkout still produces an installable
            // APK rather than an unsigned file Android refuses.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

/*
 * Four libraries, and the reason for each.
 *
 * This app has held nothing but a WebView since it was written, and that was
 * the right shape for it. Reading a QR code is the one job a web page in a
 * restaurant cannot do for itself: the station codes are printed on card, the
 * page that would read them is not served until the device already knows where
 * the server is, and a camera on a plain HTTP page is blocked by every browser
 * for good reasons that do not stop being good here.
 *
 * All four resolve at build time and ship inside the APK. Nothing here reaches
 * the internet at run time, which is the property the whole product is built
 * on: a restaurant with its router unplugged still opens for lunch.
 */
dependencies {
    // A lifecycle owner, which is what CameraX binds a camera to. The activity
    // was a bare android.app.Activity and had no lifecycle to offer.
    implementation("androidx.activity:activity:1.9.3")

    // The camera. `camera-view` carries PreviewView, which handles the parts of
    // showing a preview that are genuinely hard — rotation, aspect, the
    // difference between a fold and a phone.
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")

    // The decoder. Pure Java, no native part, no network, ~500 KB.
    implementation("com.google.zxing:core:3.5.3")
}
