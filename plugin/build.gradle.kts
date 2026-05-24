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
    compileOnly("io.specmatic:specmatic-core:2.6.0")

    // HTTP client to call the Node engine's /_engine/forward endpoint.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // JSON serialisation for forwarded request/response shapes.
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.16.0")

    // YAML config file parsing.
    implementation("org.yaml:snakeyaml:2.2")

    // Logging facade; Specmatic provides an SLF4J implementation on its classpath.
    implementation("org.slf4j:slf4j-api:2.0.9")

    // Test dependencies
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    // Specmatic types needed in tests.
    testImplementation("io.specmatic:specmatic-core:2.6.0")

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
