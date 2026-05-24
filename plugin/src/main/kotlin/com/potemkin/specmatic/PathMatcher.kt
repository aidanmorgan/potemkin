package com.potemkin.specmatic

/**
 * Checks whether an inbound request path matches any of the configured patterns.
 *
 * Supported pattern syntax (each pattern is a slash-delimited path):
 *   - exact match: `/exact/match`
 *   - single-segment wildcard: `/items/STAR` (replace STAR with asterisk — matches one segment)
 *   - multi-segment wildcard: `/loans/STAR_STAR` (replace with ** — matches any number of segments)
 *   - named-capture segment: `/customers/{id}` (treated identically to single-segment wildcard)
 *   - mixed: `/a/{b}/c/{d}`
 *
 * Patterns are compiled to regular expressions once at construction time.
 */
class PathMatcher(patterns: List<String>) {

    private val compiled: List<Regex> = patterns.map { compile(it) }

    /** Returns true if [path] matches at least one configured pattern. */
    fun matches(path: String?): Boolean {
        if (path == null) return false
        // Normalise away trailing slashes for comparison purposes.
        val normalised = path.trimEnd('/')
        return compiled.any { it.matches(normalised) }
    }

    companion object {
        /**
         * Converts a path pattern into a [Regex].
         *
         * Rules applied per slash-delimited segment:
         *   `**`          - matches zero or more path segments (greedy)
         *   `*`           - matches exactly one segment (no slashes)
         *   `{name}`      - matches exactly one segment (no slashes); name is ignored at runtime
         *   anything else - literal, regex-escaped
         */
        internal fun compile(pattern: String): Regex {
            val trimmed = pattern.trimEnd('/')
            val sb = StringBuilder()

            val segments = trimmed.split("/")
            var first = true

            for (seg in segments) {
                if (first && seg.isEmpty()) {
                    // Leading slash → emit literal slash anchor
                    sb.append("/")
                    first = false
                    continue
                }
                if (!first) {
                    sb.append("/")
                }
                first = false

                when {
                    seg == "**" -> {
                        // Replace the preceding "/" we just emitted with an optional-slash-then-anything.
                        if (sb.endsWith("/")) {
                            sb.deleteCharAt(sb.length - 1)
                        }
                        sb.append("(/.*)?")
                    }
                    seg == "*" -> sb.append("[^/]+")
                    seg.startsWith("{") && seg.endsWith("}") -> sb.append("[^/]+")
                    else -> sb.append(Regex.escape(seg))
                }
            }

            return Regex("^${sb}$")
        }
    }
}
