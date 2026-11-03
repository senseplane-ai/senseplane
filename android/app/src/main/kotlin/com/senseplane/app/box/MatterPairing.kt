// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** The steps of adding a new Matter device over Bluetooth (ADR 0073), as the bridge names them. */
enum class BleStep(val key: String, val label: String) {
    Find("finding", "Find it over Bluetooth"),
    Connect("connecting", "Connect to it"),
    Secure("securing", "Check the pairing code"),
    Check("checking", "Check it's a genuine Matter device"),
    Network("network", "Give it your network"),
    Join("joining", "Wait for it to join your network"),
    Finish("finishing", "Finish adding it"),
    ;

    companion object {
        fun of(key: String): BleStep? = entries.firstOrNull { it.key == key }
    }
}

enum class StepState { Done, Now, Failed, Todo }

/** What the person has to give again when the device asks. */
enum class Needs { WiFi, Thread }

/** Where adding over Bluetooth is: nothing yet, a step running, added, or failed (and why). */
sealed interface BlePairing {
    data object Idle : BlePairing
    data class Working(val step: BleStep) : BlePairing
    data class Added(val sensors: Int, val note: String?) : BlePairing
    data class Failed(val at: BleStep?, val message: String, val needs: Needs? = null) : BlePairing
}

@Serializable
private data class Added(
    val sensors: Int = 0,
    val certified: Boolean = false,
    val note: String? = null,
    val revocation: String? = null,
)

/** The logic of the Bluetooth screen, kept off Android so it can be tested. */
object MatterPairing {
    private val json = Json { ignoreUnknownKeys = true }

    /** The runtime permissions for scanning and connecting: nearby devices from Android 12, location before. */
    fun permissions(sdk: Int): List<String> =
        if (sdk >= 31) listOf("android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT")
        else listOf("android.permission.ACCESS_FINE_LOCATION")

    /** Whether it looks like a pairing code (the bridge checks it properly). */
    fun looksLikeCode(code: String): Boolean {
        val t = code.trim()
        if (t.uppercase().startsWith("MT:")) return t.length > 3
        val digits = t.filter { it.isDigit() }
        return (digits.length == 11 || digits.length == 21) && t.all { it.isDigit() || it == '-' || it == ' ' }
    }

    /** Whether the person gave enough to start: a code and a network (Wi-Fi name, or a Thread dataset). */
    fun canStart(code: String, ssid: String, dataset: String): Boolean =
        looksLikeCode(code) && (ssid.isNotBlank() || dataset.isNotBlank())

    /** A failure from the bridge: "needs-wifi: ..." and "needs-thread: ..." ask for that network. */
    fun failure(at: BleStep?, message: String?): BlePairing.Failed {
        val m = message?.trim().orEmpty().ifEmpty { "Couldn't add it." }
        return when {
            m.startsWith("needs-wifi:") -> BlePairing.Failed(at, m.removePrefix("needs-wifi:").trim(), Needs.WiFi)
            m.startsWith("needs-thread:") -> BlePairing.Failed(at, m.removePrefix("needs-thread:").trim(), Needs.Thread)
            else -> BlePairing.Failed(at, m.replaceFirstChar { it.uppercase() })
        }
    }

    /** The bridge's answer once added, in words. */
    fun added(resultJson: String): BlePairing.Added {
        val a = runCatching { json.decodeFromString<Added>(resultJson) }.getOrDefault(Added())
        val notes = buildList {
            if (!a.certified && a.note != null) add("Not certified: ${a.note}.")
            a.revocation?.takeIf { it.startsWith("not checked") }?.let {
                add("Its certificates couldn't be checked for revocation (${it.removePrefix("not checked:").trim()}).")
            }
        }
        return BlePairing.Added(a.sensors, notes.joinToString(" ").ifEmpty { null })
    }

    /** Each step's state, for the checklist on screen. */
    fun progress(p: BlePairing): List<Pair<BleStep, StepState>> {
        val all = BleStep.entries
        return when (p) {
            BlePairing.Idle -> all.map { it to StepState.Todo }
            is BlePairing.Added -> all.map { it to StepState.Done }
            is BlePairing.Working -> all.map { it to if (it < p.step) StepState.Done else if (it == p.step) StepState.Now else StepState.Todo }
            is BlePairing.Failed -> all.map {
                it to when {
                    p.at == null -> StepState.Todo
                    it < p.at -> StepState.Done
                    it == p.at -> StepState.Failed
                    else -> StepState.Todo
                }
            }
        }
    }

    /**
     * Whether the QR scanner may open the camera: not while this phone sends
     * its own video, which the scanner would take the camera from.
     */
    fun canScanQr(beACamera: Boolean, boxRunning: Boolean): Boolean = !(beACamera && boxRunning)

    /** A Wi-Fi name as Android gives it (in quotes, or unknown without location). */
    fun ssid(raw: String?): String {
        val s = raw?.trim()?.removeSurrounding("\"").orEmpty()
        return if (s == "<unknown ssid>" || s == "0x") "" else s
    }
}
