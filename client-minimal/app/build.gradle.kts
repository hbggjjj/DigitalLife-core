plugins {
    id("com.android.application")
}

android {
    namespace = "digitallife.channel"
    compileSdk = 37

    defaultConfig {
        applicationId = "digitallife.channel"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // 没有任何第三方依赖：只用 AndroidX 的 appcompat 都不需要，纯 Framework View
}
