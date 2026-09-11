plugins {
    id("com.android.application")
}

android {
    namespace = "com.qserve.terminal"
    compileSdk = 35

    defaultConfig {
        // Android 8 and up: the adaptive launcher icon is one vector rather
        // than five bitmaps, and every tablet a restaurant is likely to buy
        // second-hand today is past it.
        minSdk = 26
        targetSdk = 35
        versionCode = 16
        versionName = "1.0.15"
    }

    buildFeatures {
        // For BUILD_FOR_VENDOR below. Off by default since AGP 8.
        buildConfig = true
    }

    /*
     * Two apps, one source.
     *
     * A restaurant's phone and the vendor's phone do the same job — a window
     * onto a QServe server, remembered, with a QR scanner and a clipboard the
     * page cannot have for itself. What differs is which server, what it is
     * called, and that the vendor's holds the power to issue licences and so
     * asks for a code before it opens.
     *
     * Flavours rather than a second project: everything that is the same stays
     * the same file, and the differences are a handful of strings and one
     * boolean. Two separate codebases would have drifted by the second change.
     */
    flavorDimensions += "audience"
    productFlavors {
        create("restaurant") {
            dimension = "audience"
            applicationId = "com.qserve.terminal"
            buildConfigField("boolean", "BUILD_FOR_VENDOR", "false")
            // A restaurant's terminal is told where it belongs by the station
            // code it scans, so there is nothing to bake in here.
            buildConfigField("String", "VENDOR_URL", "\"\"")
            buildConfigField("String", "VENDOR_CODE", "\"\"")
        }
        create("developer") {
            dimension = "audience"
            // A different id on purpose: a vendor testing against a restaurant
            // installs both, and one must not replace the other.
            applicationId = "com.qserve.vendor"
            buildConfigField("boolean", "BUILD_FOR_VENDOR", "true")

            /*
             * Where this build goes, and the code it opens with.
             *
             * A restaurant's terminal has to be told which restaurant it belongs
             * to, because there are many of them and the app cannot know. The
             * vendor has exactly one licence server — their own — so asking them
             * for its address every time they install the app is asking a
             * question with one possible answer. Baked in at build time, the app
             * opens straight onto the console.
             *
             * Both come from outside this file and neither has a default. They
             * are read from gradle properties or the environment, which is how
             * the release workflow passes them in from repository secrets —
             * because an .apk can be taken apart by anyone who has it, and a
             * value written here would additionally be readable by anyone who
             * can see this repository, which is a different and larger set of
             * people. Absent, the app simply asks, as it did before.
             */
            val vendorUrl = (project.findProperty("qserve.vendor.url") as String?)
                ?: System.getenv("QSERVE_VENDOR_URL") ?: ""
            val vendorCode = (project.findProperty("qserve.vendor.code") as String?)
                ?: System.getenv("QSERVE_VENDOR_CODE") ?: ""

            buildConfigField("String", "VENDOR_URL", "\"${vendorUrl.trim()}\"")
            buildConfigField("String", "VENDOR_CODE", "\"${vendorCode.trim()}\"")
        }
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
    // A lifecycle owner, which is what CameraX binds a camera to.
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
