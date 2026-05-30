package com.potemkin.specmatic

/**
 * Kotlin port of `applyPatches` from `src/dsl/patches.ts`.
 *
 * Operates on a plain JSON model — [Map] (objects), [List] (arrays), and JSON
 * scalars ([String], [Boolean], [Number], `null`) — which is exactly the shape
 * Jackson produces when reading a JSON document and exactly the shape the TS
 * applier mutates. Keeping the model identical guarantees op-for-op parity.
 *
 * Semantics mirrored from the TS source:
 *  - RFC 6901 pointer parsing (`~1` -> `/`, `~0` -> `~`); `/-` is the array-end sentinel.
 *  - Strict navigation: intermediates are NOT auto-created; traversing a missing
 *    key or out-of-range index throws.
 *  - `replace`/`remove`/`move`+`copy` source/`append`/`prepend`/`increment`/`merge`/
 *    `upsert` all require their target to already exist.
 *  - `increment` requires a numeric target.
 *  - `merge` shallow by default, deep when `deep=true`.
 *  - `upsert` matches an array element by `key` field equality, replacing or appending.
 *  - Atomic: patches apply to a deep clone; the first failure throws
 *    [PatchApplyException] and the original input is left untouched.
 */
object PatchApplier {

    /**
     * Returns a fresh value derived from `state + patches`; never mutates [state].
     * Throws [PatchApplyException] on the first failed op, discarding the candidate.
     */
    fun apply(state: Any?, patches: List<Patch>): Any? {
        val candidate = cloneJson(state)
        // The root is mutable only when it is a container; ops are forbidden on
        // the root pointer '/' (see navigate), so a top-level holder is enough.
        val holder = Holder(candidate)
        for ((i, p) in patches.withIndex()) {
            applyOne(holder, p, i)
        }
        return holder.value
    }

    private class Holder(var value: Any?)

    // ---- pointer parsing ----------------------------------------------------

    /** Parse an RFC 6901 JSON Pointer into segments. Empty string is root -> []. */
    fun parsePointer(pointer: String): List<String> {
        if (pointer == "") return emptyList()
        if (pointer == "/") return listOf("")
        if (!pointer.startsWith("/")) {
            throw IllegalArgumentException("Invalid JSON Pointer (must start with '/'): $pointer")
        }
        return pointer.substring(1)
            .split("/")
            .map { it.replace("~1", "/").replace("~0", "~") }
    }

    fun joinPointer(segments: List<String>): String {
        if (segments.isEmpty()) return ""
        return "/" + segments.joinToString("/") { it.replace("~", "~0").replace("/", "~1") }
    }

    // ---- cloning ------------------------------------------------------------

    @Suppress("UNCHECKED_CAST")
    fun cloneJson(v: Any?): Any? = when (v) {
        null -> null
        is Map<*, *> -> {
            val out = LinkedHashMap<String, Any?>(v.size)
            for ((k, value) in v) out[k as String] = cloneJson(value)
            out
        }
        is List<*> -> v.map { cloneJson(it) }.toMutableList()
        else -> v
    }

    // ---- navigation ---------------------------------------------------------

    private class NavResult(val parent: Any, val key: Any, val exists: Boolean)

    @Suppress("UNCHECKED_CAST")
    private fun navigate(root: Holder, segments: List<String>, op: String, index: Int): NavResult {
        if (segments.isEmpty()) {
            throw PatchApplyException("Operation '$op' cannot target the root '/'", index, "/", op)
        }
        var cur: Any? = root.value
        for (i in 0 until segments.size - 1) {
            val seg = segments[i]
            when (cur) {
                is List<*> -> {
                    val idx = seg.toIntOrNull()
                    if (idx == null || idx < 0 || idx >= cur.size) {
                        throw PatchApplyException(
                            "Array index out of range at segment '$seg'", index, joinPointer(segments), op,
                        )
                    }
                    cur = cur[idx]
                }
                is Map<*, *> -> {
                    if (!cur.containsKey(seg)) {
                        throw PatchApplyException(
                            "Path traverses missing object key '$seg'", index, joinPointer(segments), op,
                        )
                    }
                    cur = (cur as Map<String, Any?>)[seg]
                }
                else -> throw PatchApplyException(
                    "Path traverses non-object/array at segment '$seg' (depth $i)", index, joinPointer(segments), op,
                )
            }
        }

        val leaf = segments.last()
        return when (cur) {
            is List<*> -> {
                if (leaf == "-") {
                    NavResult(cur, cur.size, false)
                } else {
                    val idx = leaf.toIntOrNull()
                    if (idx == null || idx < 0) {
                        throw PatchApplyException("Invalid array index '$leaf'", index, joinPointer(segments), op)
                    }
                    NavResult(cur, idx, idx < cur.size)
                }
            }
            is Map<*, *> -> NavResult(cur, leaf, cur.containsKey(leaf))
            else -> throw PatchApplyException(
                "Path traverses non-object/array at leaf '$leaf'", index, joinPointer(segments), op,
            )
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun readAt(nav: NavResult): Any? = when (val parent = nav.parent) {
        is List<*> -> parent[nav.key as Int]
        else -> (parent as Map<String, Any?>)[nav.key as String]
    }

    @Suppress("UNCHECKED_CAST")
    private fun setAt(nav: NavResult, value: Any?) {
        when (val parent = nav.parent) {
            is MutableList<*> -> (parent as MutableList<Any?>)[nav.key as Int] = value
            is MutableMap<*, *> -> (parent as MutableMap<String, Any?>)[nav.key as String] = value
            else -> throw IllegalStateException("container is not mutable")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun insertAt(nav: NavResult, value: Any?) {
        when (val parent = nav.parent) {
            is MutableList<*> -> (parent as MutableList<Any?>).add(nav.key as Int, value)
            is MutableMap<*, *> -> (parent as MutableMap<String, Any?>)[nav.key as String] = value
            else -> throw IllegalStateException("container is not mutable")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun deleteAt(nav: NavResult) {
        when (val parent = nav.parent) {
            is MutableList<*> -> (parent as MutableList<Any?>).removeAt(nav.key as Int)
            is MutableMap<*, *> -> (parent as MutableMap<String, Any?>).remove(nav.key as String)
            else -> throw IllegalStateException("container is not mutable")
        }
    }

    // ---- op dispatch --------------------------------------------------------

    @Suppress("UNCHECKED_CAST")
    private fun applyOne(root: Holder, patch: Patch, index: Int) {
        when (patch) {
            is Patch.Add -> {
                val segments = parsePointer(patch.path)
                if (segments.isEmpty()) {
                    throw PatchApplyException("'add' on root '/' is not supported", index, "/", patch.op)
                }
                val nav = navigate(root, segments, patch.op, index)
                if (nav.parent is List<*>) insertAt(nav, cloneJson(patch.value))
                else setAt(nav, cloneJson(patch.value))
            }
            is Patch.Replace -> {
                val segments = parsePointer(patch.path)
                if (segments.isEmpty()) {
                    throw PatchApplyException("'replace' on root '/' is not supported", index, "/", patch.op)
                }
                val nav = navigate(root, segments, patch.op, index)
                if (!nav.exists) {
                    throw PatchApplyException(
                        "'replace' target does not exist: ${patch.path}", index, patch.path, patch.op,
                    )
                }
                setAt(nav, cloneJson(patch.value))
            }
            is Patch.Remove -> {
                val nav = navigate(root, parsePointer(patch.path), patch.op, index)
                if (!nav.exists) {
                    throw PatchApplyException(
                        "'remove' target does not exist: ${patch.path}", index, patch.path, patch.op,
                    )
                }
                deleteAt(nav)
            }
            is Patch.Move -> applyMoveCopy(root, patch.from, patch.path, "move", index)
            is Patch.Copy -> applyMoveCopy(root, patch.from, patch.path, "copy", index)
            is Patch.Append -> applyAppendPrepend(root, patch.path, patch.value, prepend = false, index)
            is Patch.Prepend -> applyAppendPrepend(root, patch.path, patch.value, prepend = true, index)
            is Patch.Increment -> {
                val nav = navigate(root, parsePointer(patch.path), patch.op, index)
                if (!nav.exists) {
                    throw PatchApplyException(
                        "'increment' target does not exist: ${patch.path}", index, patch.path, patch.op,
                    )
                }
                val current = readAt(nav)
                if (current !is Number || current is Boolean) {
                    throw PatchApplyException(
                        "'increment' target is not numeric: ${patch.path}", index, patch.path, patch.op,
                    )
                }
                setAt(nav, addNumbers(current, patch.by))
            }
            is Patch.Merge -> {
                val nav = navigate(root, parsePointer(patch.path), patch.op, index)
                if (!nav.exists) {
                    throw PatchApplyException(
                        "'merge' target does not exist: ${patch.path}", index, patch.path, patch.op,
                    )
                }
                val target = readAt(nav)
                if (target !is MutableMap<*, *>) {
                    throw PatchApplyException(
                        "'merge' target is not an object: ${patch.path}", index, patch.path, patch.op,
                    )
                }
                val obj = target as MutableMap<String, Any?>
                val update = cloneJson(patch.value) as Map<String, Any?>
                if (patch.deep) deepMergeInPlace(obj, update)
                else for ((k, v) in update) obj[k] = v
            }
            is Patch.Upsert -> {
                val nav = navigate(root, parsePointer(patch.path), patch.op, index)
                if (!nav.exists) {
                    throw PatchApplyException(
                        "'upsert' target does not exist: ${patch.path}", index, patch.path, patch.op,
                    )
                }
                val target = readAt(nav)
                if (target !is MutableList<*>) {
                    throw PatchApplyException(
                        "'upsert' target is not an array: ${patch.path}", index, patch.path, patch.op,
                    )
                }
                val arr = target as MutableList<Any?>
                val incoming = cloneJson(patch.value) as Map<String, Any?>
                val matchValue = incoming[patch.key]
                var idx = -1
                for (i in arr.indices) {
                    val item = arr[i]
                    if (item is Map<*, *> && item[patch.key] == matchValue) {
                        idx = i
                        break
                    }
                }
                if (idx >= 0) arr[idx] = incoming else arr.add(incoming)
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun applyMoveCopy(root: Holder, from: String, path: String, op: String, index: Int) {
        val fromSegs = parsePointer(from)
        val toSegs = parsePointer(path)
        val fromNav = navigate(root, fromSegs, op, index)
        if (!fromNav.exists) {
            throw PatchApplyException("'$op' source does not exist: $from", index, from, op)
        }
        val value = readAt(fromNav)
        val cloned = cloneJson(value)
        if (op == "move") deleteAt(fromNav)
        // Re-navigate the destination AFTER any move-delete, mirroring the TS order.
        val toNav = navigate(root, toSegs, op, index)
        if (toNav.parent is List<*>) insertAt(toNav, cloned) else setAt(toNav, cloned)
    }

    @Suppress("UNCHECKED_CAST")
    private fun applyAppendPrepend(root: Holder, path: String, value: Any?, prepend: Boolean, index: Int) {
        val op = if (prepend) "prepend" else "append"
        val nav = navigate(root, parsePointer(path), op, index)
        if (!nav.exists) {
            throw PatchApplyException("'$op' target does not exist: $path", index, path, op)
        }
        val target = readAt(nav)
        if (target !is MutableList<*>) {
            throw PatchApplyException("'$op' target is not an array: $path", index, path, op)
        }
        val arr = target as MutableList<Any?>
        val cloned = cloneJson(value)
        if (prepend) arr.add(0, cloned) else arr.add(cloned)
    }

    @Suppress("UNCHECKED_CAST")
    private fun deepMergeInPlace(target: MutableMap<String, Any?>, update: Map<String, Any?>) {
        for ((k, v) in update) {
            val existing = target[k]
            if (existing is MutableMap<*, *> && v is Map<*, *>) {
                deepMergeInPlace(existing as MutableMap<String, Any?>, v as Map<String, Any?>)
            } else {
                target[k] = v
            }
        }
    }

    /**
     * Add two numbers, preserving integral output when both operands are integral
     * (so `5 + 1` serialises as `6`, not `6.0`) — matching JS number semantics
     * where `5 + 1 === 6`.
     */
    private fun addNumbers(a: Number, b: Number): Number {
        val ad = a.toDouble()
        val bd = b.toDouble()
        val sum = ad + bd
        return if (ad == Math.floor(ad) && bd == Math.floor(bd) &&
            !sum.isInfinite() && sum == Math.floor(sum) &&
            sum >= Long.MIN_VALUE.toDouble() && sum <= Long.MAX_VALUE.toDouble()
        ) {
            sum.toLong()
        } else {
            sum
        }
    }
}

/**
 * Thrown when a patch op fails. Carries the failing patch index, JSON Pointer,
 * and op so callers can surface a precise diagnostic (and the response
 * interceptor can attach a `Warning` header). Mirrors the TS `PatchApplyError`.
 */
class PatchApplyException(
    message: String,
    val patchIndex: Int,
    val path: String,
    val op: String,
) : RuntimeException(message)
