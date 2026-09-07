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
        versionCode = 1
        versionName = "1.0.0"
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
