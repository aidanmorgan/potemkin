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
open class PathMatcher(patterns: List<String>) {

    private val compiled: List<Regex> = patterns.map { compile(it) }

    /** Returns true if [path] matches at least one configured pattern. */
    open fun matches(path: String?): Boolean {
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
            // Normalise: strip trailing slash, ensure exactly one leading slash.
            val normalised = "/" + pattern.trimStart('/').trimEnd('/')
            // Split on the leading slash to get the non-empty segments.
            val segments = normalised.removePrefix("/").split("/")
            // Start the buffer with the mandatory leading slash.
            val sb = StringBuilder("/")

            for ((index, seg) in segments.withIndex()) {
                // Append segment separator before every segment except the first.
                if (index > 0) sb.append("/")

                when {
                    seg == "**" -> {
                        // Delete the preceding separator (or the initial '/') so that
                        // "/loans" + "/**" becomes "/loans(/.*)?", not "/loans/(/.*)?".
                        sb.deleteCharAt(sb.length - 1)
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
