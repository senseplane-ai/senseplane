// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.api

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.doubleOrNull
import kotlin.math.roundToInt

// Plain words for devices and their commands, shared by the screens and the
// box service's notification.

internal fun num(v: Double) = if (v == v.roundToInt().toDouble()) "${v.roundToInt()}" else "%.1f".format(v)

/** "turn on Hall light", "set Hall light to 40%", "unlock Front door" … */
fun actionWords(action: String, name: String, value: String? = null): String {
    val v = value ?: "?"
    return when (action) {
        "turn_on" -> "turn on $name"
        "turn_off" -> "turn off $name"
        "set_brightness" -> "set $name to $v%"
        "set_position" -> "open $name to $v%"
        "set_temperature" -> "set $name to $v °C"
        "set_mode" -> "set $name to ${v.replace('_', ' ')}"
        "arm_away" -> "arm $name (away)"
        "arm_home" -> "arm $name (home)"
        else -> "${action.replace('_', ' ')} $name" // open, close, lock, unlock, disarm
    }
}

/** The button for an action. */
fun actionLabel(action: String): String = when (action) {
    "turn_on" -> "Turn on"
    "turn_off" -> "Turn off"
    "arm_away" -> "Arm away"
    "arm_home" -> "Arm home"
    else -> action.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

/** "Assistant asks to unlock Front door." */
fun askText(c: DeviceCommand): String {
    val who = c.requestedBy?.name?.takeIf { it.isNotBlank() } ?: if (c.requestedBy?.kind == "agent") "An agent" else "Someone"
    val value = c.value?.takeUnless { it is JsonNull }?.let { p -> p.doubleOrNull?.let(::num) ?: p.content }
    return "$who asks to ${actionWords(c.action, c.deviceName.ifBlank { "a device" }, value)}."
}

/** What a device reads now, in a few words. */
fun stateText(d: Device): String {
    val s = d.state ?: return "No reading yet"
    if (s.available == false) return "Unavailable"
    return when (d.type) {
        "lock" -> when (s.locked) { true -> "Locked"; false -> "Unlocked"; null -> "No reading yet" }
        "cover", "garage_door", "gate" -> when {
            s.moving == "opening" -> "Opening…"
            s.moving == "closing" -> "Closing…"
            s.open == true -> if (s.position != null && s.position < 100) "Open ${num(s.position)}%" else "Open"
            s.open == false -> "Closed"
            else -> "No reading yet"
        }
        "climate" -> listOfNotNull(s.targetTemperature?.let { "Set to ${num(it)} °C" }, s.mode?.replace('_', ' ')).joinToString(" · ").ifEmpty { "No reading yet" }
        "alarm" -> s.alarm?.replace('_', ' ')?.replaceFirstChar { it.uppercase() } ?: "No reading yet"
        else -> when (s.on) {
            true -> if (s.brightness != null && s.brightness < 100) "On ${num(s.brightness)}%" else "On"
            false -> "Off"
            null -> "No reading yet"
        }
    }
}

/** The command's own message, or plain words for its status if it has none. */
fun commandText(c: DeviceCommand): String = c.message.ifBlank {
    val name = c.deviceName.ifBlank { "The device" }
    when (c.status) {
        "done" -> "Done."
        "unchanged" -> "Sent, but $name didn't change."
        "in_progress" -> "$name is on its way."
        "sent" -> "Sent. No answer from $name yet."
        "awaiting_confirmation" -> "Waiting for a person to confirm."
        "denied" -> "Denied."
        "expired" -> "Nobody confirmed in time, so it didn't run."
        "refused" -> "Senseplane refused this."
        "offline" -> "$name's box isn't reporting, so it didn't run."
        "failed" -> "$name couldn't do it."
        else -> c.status
    }
}

/** True when the device did what was asked. */
fun commandWorked(c: DeviceCommand) = c.status == "done"

/** True while an answer may still come (poll it). */
fun commandPending(c: DeviceCommand) = c.status == "sent" || c.status == "in_progress"
