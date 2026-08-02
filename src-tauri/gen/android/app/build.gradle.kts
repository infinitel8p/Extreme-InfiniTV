import java.util.Locale
import java.util.Properties
import com.android.build.gradle.internal.cxx.configure.gradleLocalProperties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) propFile.inputStream().use { load(it) }
}

/** Read from user gradle.properties OR environment, fail fast if missing */
fun required(name: String): String =
    providers.gradleProperty(name)
        .orElse(providers.environmentVariable(name))
        .orNull ?: error("Missing signing property: $name")

android {
    namespace = "com.infinitel8p.xtream"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.infinitel8p.xtream"
        minSdk = 26
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        manifestPlaceholders["usesCleartextTraffic"] = "false"

        // TV build (XTREAM_TV_BUILD): leanback required + versionCode offset
        val isTvBuild = (System.getenv("XTREAM_TV_BUILD") ?: "").lowercase(Locale.ROOT) in listOf("1", "true", "yes")
        manifestPlaceholders["leanbackRequired"] = if (isTvBuild) "true" else "false"
        if (isTvBuild) {
            val tvVersionCodeOffset = 5
            versionCode = (versionCode ?: 0) + tvVersionCodeOffset
        }

        // Lets CI (beta builds) assign a versionCode ahead of the sync-version pin.
        val versionCodeOverride = (System.getenv("XTREAM_VERSION_CODE_OVERRIDE") ?: "").toIntOrNull()
        if (versionCodeOverride != null) {
            versionCode = versionCodeOverride
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    val keystoreFile = providers.gradleProperty("XTREAM_KEYSTORE_FILE")
        .orElse(providers.environmentVariable("XTREAM_KEYSTORE_FILE"))
        .orNull
    if (keystoreFile != null) {
        signingConfigs {
            create("release") {
                storeFile = file(keystoreFile)
                storePassword = required("XTREAM_KEYSTORE_PASSWORD")
                keyAlias = required("XTREAM_KEY_ALIAS")
                keyPassword = required("XTREAM_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            packaging {
                jniLibs.keepDebugSymbols.add("**/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("**/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("**/x86/*.so")
                jniLibs.keepDebugSymbols.add("**/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfigs.findByName("release")?.let { signingConfig = it }
            ndk {
                debugSymbolLevel = "FULL"
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }

    buildFeatures { buildConfig = true }
}

rust {
    // Must resolve to the pnpm root: npm 11+ no longer walks up to find package.json.
    rootDirRel = "../../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.4.1")
    implementation("androidx.media3:media3-exoplayer-dash:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("androidx.media3:media3-session:1.4.1")
    implementation("io.coil-kt:coil:2.7.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
