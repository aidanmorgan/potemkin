package com.potemkin.specmatic

/**
 * Thrown during plugin boot when configuration is unusable — for example a
 * malformed potemkin.yaml (`BOOT_ERR_INVALID_YAML`). The message carries a
 * stable `BOOT_ERR_*` code prefix and, where available, a `file:line` locator.
 */
class PluginBootException(
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)
