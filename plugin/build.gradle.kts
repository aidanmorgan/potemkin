import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar

plugins {
    kotlin("jvm") version "2.2.0"
    id("com.gradleup.shadow") version "8.3.6"
}

group = "com.potemkin"
version = "1.0.0"

// Target JVM 17 bytecode via Kotlin and Java compile options.
// We do not use a Java toolchain because only Java 25 is available on this host;
// toolchain constraints would cause a "no matching JDK" failure.
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

tasks.withType<JavaCompile> {
    sourceCompatibility = "17"
    targetCompatibility = "17"
}

repositories {
    mavenCentral()
}

dependencies {
    // Specmatic provides its own classes at runtime via the classpath; compileOnly keeps them out of our fat-jar.
    compileOnly("io.specmatic:specmatic-core:2.46.2")

    // HTTP client to call the Node engine's /_engine/forward endpoint.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // JSON serialisation for forwarded request/response shapes.
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.16.0")

    // YAML config file parsing.
    implementation("org.yaml:snakeyaml:2.2")

    // Logging facade; Specmatic provides an SLF4J implementation on its classpath.
    implementation("org.slf4j:slf4j-api:2.0.9")

    // Coroutines — used by HealthMonitor probe loop and FixtureLifecycleManager refresh loop.
    // Specmatic bundles coroutines transitively; we declare it explicitly for compile-time safety.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")

    // Resilience4j — retry + circuit breaker for ResilientForwarder.
    implementation("io.github.resilience4j:resilience4j-retry:2.2.0")
    implementation("io.github.resilience4j:resilience4j-circuitbreaker:2.2.0")
    implementation("io.github.resilience4j:resilience4j-kotlin:2.2.0")

    // Ktor server (Netty engine) — ControlServer. Matches Specmatic's bundled Ktor 2.3.13.
    implementation("io.ktor:ktor-server-core-jvm:2.3.13")
    implementation("io.ktor:ktor-server-netty-jvm:2.3.13")
    implementation("io.ktor:ktor-server-content-negotiation-jvm:2.3.13")
    implementation("io.ktor:ktor-serialization-jackson-jvm:2.3.13")

    // Test dependencies
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.0")

    // Specmatic types needed in tests.
    testImplementation("io.specmatic:specmatic-core:2.46.2")

    // Ktor test client for ControlServerTest.
    testImplementation("io.ktor:ktor-server-test-host-jvm:2.3.13")
    testImplementation("io.ktor:ktor-client-content-negotiation-jvm:2.3.13")

    // SLF4J simple binding for tests (avoids "no binding" warning).
    testRuntimeOnly("org.slf4j:slf4j-simple:2.0.9")
}

tasks.test {
    useJUnitPlatform()
}

tasks.named<ShadowJar>("shadowJar") {
    archiveBaseName.set("potemkin-stateful-plugin")
    archiveClassifier.set("")
    archiveVersion.set("")

    // Do NOT bundle specmatic-core — it is provided on the Specmatic classpath at runtime.
    dependencies {
        exclude(dependency("io.specmatic:specmatic-core"))
    }

    mergeServiceFiles()
}
