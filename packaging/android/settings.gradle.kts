/*
 * QServe Terminal — the Android app a restaurant installs on its own devices.
 *
 * It is a window onto the restaurant's own server, not a copy of it: the
 * kitchen tablet, the waiter's phone and the tablet propped on a table all
 * point at the computer running QServe. Nothing about the restaurant lives in
 * this app, which is what makes losing a phone a nuisance rather than an
 * incident.
 */

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "QServeTerminal"
include(":app")
