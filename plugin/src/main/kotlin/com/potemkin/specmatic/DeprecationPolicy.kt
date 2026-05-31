package com.potemkin.specmatic

/**
 * Derives which HTTP operations an `overlay.patches` block marks `deprecated:true`
 * in the OpenAPI document, and matches inbound requests against them.
 *
 * Specmatic applies the overlay to the spec it serves (verified: the
 * `overlayFilePath` env var loads the overlay at `HttpStub` construction), but it
 * does NOT emit a `Deprecation` header for deprecated operations. The plugin's
 * [PotemkinResponseInterceptor] consults this policy to attach `Deprecation: true`
 * to responses for deprecated operations (E5 / AC-G6.3).
 *
 * An overlay patch deprecates an operation when its RFC 6901 pointer addresses an
 * operation's `deprecated` flag with a truthy value, e.g.
 *   `{ op: add, path: "/paths/~1leads~1{id}/get/deprecated", value: true }`.
 * The pointer decodes to segments `[paths, /leads/{id}, get, deprecated]`; the
 * operation is `(GET, /leads/{id})`. The path template is matched against actual
 * request paths via [PathMatcher] (so `/leads/{id}` matches `/leads/<uuid>`).
 */
class DeprecationPolicy private constructor(
    private val entries: List<Entry>,
) {
    private data class Entry(val method: String, val matcher: PathMatcher)

    /** True when `(method, path)` resolves to an operation the overlay deprecated. */
    fun isDeprecated(method: String?, path: String?): Boolean {
        if (method == null || path == null) return false
        val m = method.uppercase()
        return entries.any { it.method == m && it.matcher.matches(path) }
    }

    companion object {
        private val HTTP_METHODS = setOf(
            "GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE",
        )

        /**
         * Build a policy from overlay patches. Only `add`/`replace` patches whose
         * pointer ends `…/paths/<template>/<method>/deprecated` with a truthy value
         * contribute an entry; everything else is ignored (it changes the served
         * spec but doesn't toggle deprecation).
         */
        fun fromOverlayPatches(patches: List<Patch>): DeprecationPolicy {
            val entries = mutableListOf<Entry>()
            for (p in patches) {
                val (pointer, value) = when (p) {
                    is Patch.Add -> p.path to p.value
                    is Patch.Replace -> p.path to p.value
                    else -> continue
                }
                if (!isTruthy(value)) continue
                val parsed = parseDeprecatedPointer(pointer) ?: continue
                entries += Entry(parsed.first, PathMatcher(listOf(parsed.second)))
            }
            return DeprecationPolicy(entries)
        }

        private fun isTruthy(value: Any?): Boolean = when (value) {
            is Boolean -> value
            is String -> value.equals("true", ignoreCase = true)
            else -> false
        }

        /**
         * Decode a pointer of the form `/paths/<encodedTemplate>/<method>/deprecated`
         * into `(METHOD, /path/template)`. Returns null when the pointer does not
         * address an operation's deprecated flag.
         */
        private fun parseDeprecatedPointer(pointer: String): Pair<String, String>? {
            val segs = PatchApplier.parsePointer(pointer)
            // [paths, <template>, <method>, deprecated]
            if (segs.size != 4) return null
            if (segs[0] != "paths") return null
            if (segs[3] != "deprecated") return null
            val method = segs[2].uppercase()
            if (method !in HTTP_METHODS) return null
            val template = segs[1]
            if (!template.startsWith("/")) return null
            return method to template
        }
    }
}
