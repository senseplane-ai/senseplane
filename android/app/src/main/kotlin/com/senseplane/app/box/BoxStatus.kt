// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** The bridge's status (bridge/mobile Status). */
@Serializable
data class BoxStatus(
    val state: String = "stopped",
    val code: String? = null,
    val link: String? = null,
    val expires: String? = null,
    val error: String? = null,
    val cameras: List<CameraState> = emptyList(),
    val sensors: Int = 0,
    val sending: Int = 0,
    val found: Int = 0,
    @SerialName("phone_camera") val phoneCamera: String? = null,
) {
    val pairing get() = state == "pairing"
    val running get() = state == "running"
}

@Serializable
data class CameraState(
    @SerialName("source_id") val sourceId: String,
    val state: String,
    val detail: String? = null,
)

/** A camera the phone found on the Wi-Fi. */
@Serializable
data class FoundCamera(
    val id: String,
    val address: String? = null,
    val manufacturer: String? = null,
    val model: String? = null,
    val name: String? = null,
    val onvif: Boolean = false,
) {
    val title get() = listOfNotNull(manufacturer, model).joinToString(" ").ifBlank { name ?: address ?: "Camera" }
}

/** One of the phone's sensors and whether it is sent. */
@Serializable
data class Sensor(
    @SerialName("entity_id") val entityId: String,
    val name: String,
    val area: String? = null,
    val sense: String,
    val kind: String,
    val chosen: Boolean,
    val listed: Boolean = true,
) {
    /** Where it comes from: the phone itself or a Bluetooth sensor nearby. */
    val group get() = if (entityId.startsWith("bthome.")) "Bluetooth sensors nearby" else if (entityId.startsWith("phone.")) "This phone" else "Other"
}

val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

fun parseStatus(raw: String): BoxStatus = runCatching { json.decodeFromString<BoxStatus>(raw) }.getOrDefault(BoxStatus())
fun parseFound(raw: String): List<FoundCamera> = runCatching { json.decodeFromString<List<FoundCamera>>(raw) }.getOrDefault(emptyList())
fun parseSensors(raw: String): List<Sensor> = runCatching { json.decodeFromString<List<Sensor>>(raw) }.getOrDefault(emptyList())

/** What a sense is called (spec/senses.json), for the sensor list. */
fun senseName(sense: String): String = when (sense) {
    "contact" -> "door or window"
    "power" -> "power use"
    "switch" -> "on or off"
    "occupancy" -> "presence"
    "illuminance" -> "light level"
    "carbon_monoxide" -> "carbon monoxide"
    else -> sense.replace('_', ' ')
}
