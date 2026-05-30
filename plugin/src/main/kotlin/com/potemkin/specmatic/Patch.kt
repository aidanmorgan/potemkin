package com.potemkin.specmatic

/**
 * Kotlin port of the canonical Patch vocabulary defined in `src/dsl/patches.ts`.
 *
 * RFC 6902 ops (add/remove/replace/move/copy) plus Potemkin extensions
 * (append/prepend/increment/merge/upsert). Paths are RFC 6901 JSON Pointers;
 * `/items/-` is the array-end sentinel (valid for add/append).
 *
 * A patch is represented as a plain map (the JSON shape the engine emits) and
 * decoded into the typed [Patch] hierarchy by [Patch.from]. Patches arrive over
 * the wire as JSON objects, so a map-based decode keeps parity with the TS
 * source without a bespoke deserializer.
 */
sealed class Patch {
    /** The op discriminator, matching the TS `op` string exactly. */
    abstract val op: String

    data class Add(val path: String, val value: Any?) : Patch() {
        override val op = "add"
    }

    data class Remove(val path: String) : Patch() {
        override val op = "remove"
    }

    data class Replace(val path: String, val value: Any?) : Patch() {
        override val op = "replace"
    }

    data class Move(val from: String, val path: String) : Patch() {
        override val op = "move"
    }

    data class Copy(val from: String, val path: String) : Patch() {
        override val op = "copy"
    }

    data class Append(val path: String, val value: Any?) : Patch() {
        override val op = "append"
    }

    data class Prepend(val path: String, val value: Any?) : Patch() {
        override val op = "prepend"
    }

    data class Increment(val path: String, val by: Double) : Patch() {
        override val op = "increment"
    }

    data class Merge(val path: String, val value: Map<String, Any?>, val deep: Boolean = false) : Patch() {
        override val op = "merge"
    }

    data class Upsert(val path: String, val key: String, val value: Map<String, Any?>) : Patch() {
        override val op = "upsert"
    }

    companion object {
        /**
         * Decode a single wire-format patch map into a [Patch]. Throws
         * [IllegalArgumentException] on an unknown op or a missing required field.
         */
        @Suppress("UNCHECKED_CAST")
        fun from(raw: Map<String, Any?>): Patch {
            val op = raw["op"] as? String
                ?: throw IllegalArgumentException("patch missing 'op' field: $raw")
            fun path(): String = raw["path"] as? String
                ?: throw IllegalArgumentException("patch '$op' missing 'path' field: $raw")
            fun from(): String = raw["from"] as? String
                ?: throw IllegalArgumentException("patch '$op' missing 'from' field: $raw")
            return when (op) {
                "add" -> Add(path(), raw["value"])
                "remove" -> Remove(path())
                "replace" -> Replace(path(), raw["value"])
                "move" -> Move(from(), path())
                "copy" -> Copy(from(), path())
                "append" -> Append(path(), raw["value"])
                "prepend" -> Prepend(path(), raw["value"])
                "increment" -> {
                    val by = raw["by"] as? Number
                        ?: throw IllegalArgumentException("patch 'increment' missing numeric 'by' field: $raw")
                    Increment(path(), by.toDouble())
                }
                "merge" -> {
                    val value = raw["value"] as? Map<String, Any?>
                        ?: throw IllegalArgumentException("patch 'merge' 'value' must be an object: $raw")
                    val deep = raw["deep"] as? Boolean ?: false
                    Merge(path(), value, deep)
                }
                "upsert" -> {
                    val key = raw["key"] as? String
                        ?: throw IllegalArgumentException("patch 'upsert' missing 'key' field: $raw")
                    val value = raw["value"] as? Map<String, Any?>
                        ?: throw IllegalArgumentException("patch 'upsert' 'value' must be an object: $raw")
                    Upsert(path(), key, value)
                }
                else -> throw IllegalArgumentException("unknown patch op '$op'")
            }
        }

        /** Decode a list of wire-format patch maps. */
        @Suppress("UNCHECKED_CAST")
        fun fromList(raw: List<*>): List<Patch> =
            raw.map { from(it as Map<String, Any?>) }
    }
}
