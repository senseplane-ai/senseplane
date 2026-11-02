// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.senseplane.app.box.BoxHolder
import com.senseplane.app.box.FoundCamera
import com.senseplane.app.box.Sensor
import com.senseplane.app.box.senseName
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Cameras found on this Wi-Fi (ONVIF): pick one, enter its own account; or enter an RTSP address. */
@Composable
fun AddCameraScreen(onBack: () -> Unit, onAdded: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var found by remember { mutableStateOf<List<FoundCamera>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var picked by remember { mutableStateOf<FoundCamera?>(null) }
    var name by remember { mutableStateOf("") }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var manual by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        while (true) {
            found = runCatching { BoxHolder.found(context) }.getOrDefault(found)
            delay(3000)
        }
    }
    fun add() = scope.launch {
        busy = true; error = null
        val r = runCatching {
            val p = picked
            if (p != null && !manual) BoxHolder.addFound(context, p.id, user, pass, name.ifBlank { p.title })
            else BoxHolder.addByAddress(context, url.trim(), name.ifBlank { "Camera" })
        }
        busy = false
        r.exceptionOrNull()?.let { error = it.message ?: "Couldn't add it." }
        if (r.isSuccess) withContext(Dispatchers.Main) { onAdded() } // navigation is on the main thread
    }
    Screen("Add an IP camera", onBack = onBack, bottom = {
        val ready = if (manual) Regex("^rtsps?://").containsMatchIn(url.trim()) else picked != null && user.isNotBlank()
        Primary(if (busy) "Adding…" else "Add camera", enabled = ready && !busy) { add() }
    }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Label("Found on this Wi-Fi")
            Spacer(Modifier.weight(1f))
            Text(if (searching) "Looking…" else "Look again", color = Ink.live, fontSize = 13.sp, modifier = Modifier.clickable(enabled = !searching) {
                scope.launch {
                    searching = true
                    runCatching { BoxHolder.search(context) }
                    found = runCatching { BoxHolder.found(context) }.getOrDefault(found)
                    searching = false
                }
            }.padding(8.dp))
        }
        val onvif = found.filter { it.onvif }
        if (onvif.isEmpty()) Body("No cameras found yet. Cameras that speak ONVIF show up here; on a Tapo, turn on its camera account first (Camera settings → Advanced → Camera account).", color = Ink.muted, size = 13)
        else Panel {
            onvif.forEachIndexed { i, cam ->
                if (i > 0) Divider()
                val selected = picked?.id == cam.id && !manual
                Row(Modifier.fillMaxWidth().clickable { picked = cam; manual = false; if (name.isBlank()) name = cam.title }.heightIn(min = 56.dp)
                    .background(if (selected) Ink.raise else Ink.panel).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(cam.title, color = Ink.text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        Text(listOfNotNull(cam.address, "ONVIF").joinToString(" · "), color = Ink.muted, fontSize = 12.sp, fontFamily = mono)
                    }
                    Text(if (selected) "Selected" else "Add", color = Ink.live, fontSize = 13.sp)
                }
            }
        }
        if (picked != null && !manual) {
            Field("Name", name, { name = it }, placeholder = "Front door")
            Field("Camera username", user, { user = it }, placeholder = "admin")
            Field("Password", pass, { pass = it }, password = true,
                hint = "The camera's own account, not your Tapo or cloud login. The phone asks the camera for its stream; the password stays encrypted and never shows in logs.")
        }
        Text(if (manual) "Pick from the list instead" else "Not in the list? Enter its RTSP address", color = Ink.live, fontSize = 14.sp,
            modifier = Modifier.clickable { manual = !manual }.padding(vertical = 8.dp))
        if (manual) {
            Field("Name", name, { name = it }, placeholder = "Front door")
            Field("RTSP address", url, { url = it }, placeholder = "rtsp://user:password@192.168.1.60:554/stream1", monoFont = true, keyboard = KeyboardType.Uri,
                hint = "Set the camera to stream H.264.")
        }
        error?.let { StatusLine(it, Ink.warn) }
    }
}

/** The phone's sensors and Bluetooth sensors nearby: what is sent is chosen here. */
@Composable
fun SensorsScreen(onBack: () -> Unit, go: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val list = remember { mutableStateListOf<Sensor>() }
    var error by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }
    val status by BoxHolder.status.collectAsState()
    LaunchedEffect(status.sensors) {
        runCatching { BoxHolder.sensors(context) }
            .onSuccess { list.clear(); list.addAll(it.filter { s -> s.listed }); loaded = true; error = null }
            .onFailure { error = it.message }
    }
    Screen("Sensors", onBack = onBack) {
        Body("Choose what Senseplane gets. Nothing is sent until you turn it on, and you can change it any time.", color = Ink.muted, size = 13)
        if (!loaded && error == null) Body("Loading…", color = Ink.muted)
        for ((group, items) in list.groupBy { it.group }.toSortedMap(compareBy { if (it == "This phone") 0 else 1 })) {
            Label(group)
            Panel {
                items.forEachIndexed { i, s ->
                    if (i > 0) Divider()
                    ToggleRow(s.name, senseName(s.sense), s.chosen) { on ->
                        val at = list.indexOf(s)
                        list[at] = s.copy(chosen = on)
                        scope.launch {
                            runCatching { BoxHolder.choose(context, s.entityId, on) }.onFailure {
                                list[at] = s
                                error = it.message
                            }
                        }
                    }
                }
            }
        }
        if (loaded && list.isEmpty()) Body("No sensors yet. The phone's own appear once Senseplane runs; Bluetooth sensors (BTHome, such as Shelly BLU) appear when they send.", color = Ink.muted, size = 13)
        error?.let { StatusLine(it, Ink.warn) }
        if (list.none { it.group == "Matter devices" }) Label("Matter devices")
        Secondary("Add a Matter device") { go("matter") }
    }
}

/**
 * Adds a Matter device to this phone, which is its own Matter controller
 * (ADR 0065): the device is shared from the app it's in now with a pairing
 * code. Its sensors then show under Sensors, off until turned on.
 */
@Composable
fun MatterScreen(onBack: () -> Unit, onAdded: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val status by BoxHolder.status.collectAsState()
    val ready = code.filter { it.isDigit() }.length.let { it == 11 || it == 21 } || code.trim().uppercase().startsWith("MT:")
    fun add() = scope.launch {
        busy = true; error = null
        val r = runCatching { BoxHolder.addMatter(context, code.trim()) }
        busy = false
        r.exceptionOrNull()?.let { error = it.message ?: "Couldn't add it." }
        if (r.isSuccess) withContext(Dispatchers.Main) { onAdded() } // navigation is on the main thread
    }
    Screen("Add a Matter device", onBack = onBack, bottom = {
        Primary(if (busy) "Adding… this can take a minute" else "Add device", enabled = ready && !busy) { add() }
    }) {
        Body("Plugs, sensors and locks that work with Matter join this phone over Wi-Fi. Keep using them in the app they're in now; Senseplane only reads them.")
        Field("Pairing code", code, { code = it }, placeholder = "3497-011-2332", monoFont = true, keyboard = KeyboardType.Number,
            hint = "The 11 digits, or the text of its QR code (MT:…).")
        error?.let { StatusLine(it, Ink.warn) }
        Panel {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Get a code", color = Ink.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                Step(1, "In the app the device is in (Apple Home, Google Home, Alexa or the maker's app), open the device's settings.")
                Step(2, "Choose Turn on pairing mode, Share with another app or Linked Matter apps. You get an 11-digit code.")
                Step(3, "Enter it here within 15 minutes. A new device not set up anywhere yet: set it up in its own app first.")
            }
        }
        if (status.matter > 0) Body("${status.matter} Matter ${if (status.matter == 1) "device" else "devices"} on this phone. Choose what Senseplane gets under Sensors.", color = Ink.muted, size = 13)
        Body("The phone has to be on the same Wi-Fi as the device. Thread devices also need a Thread border router at home, such as a HomePod mini or Nest Hub.", color = Ink.muted, size = 13)
    }
}
