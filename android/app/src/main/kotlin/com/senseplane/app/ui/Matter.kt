// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.senseplane.app.box.BlePairing
import com.senseplane.app.box.BoxHolder
import com.senseplane.app.box.MatterPairing
import com.senseplane.app.box.Needs
import com.senseplane.app.box.StepState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Adds a Matter device to this phone, which is its own Matter controller
 * (ADR 0065): one already in another app is shared with a pairing code and
 * joins over Wi-Fi; a new one, fresh from its box, is paired over Bluetooth
 * and given the home's network (ADR 0073). Its sensors then show under
 * Sensors, off until turned on.
 */
@Composable
fun MatterScreen(onBack: () -> Unit, onAdded: () -> Unit) {
    var bluetooth by remember { mutableStateOf(false) }
    val status by BoxHolder.status.collectAsState()
    Screen("Add a Matter device", onBack = onBack) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).border(1.dp, Ink.line, RoundedCornerShape(10.dp))) {
            Choice("Already set up", !bluetooth, Modifier.weight(1f)) { bluetooth = false }
            Choice("New, over Bluetooth", bluetooth, Modifier.weight(1f)) { bluetooth = true }
        }
        if (bluetooth) BluetoothAdd(onAdded) else SharedAdd(onAdded)
        if (status.matter > 0) Body("${status.matter} Matter ${if (status.matter == 1) "device" else "devices"} on this phone. Choose what Senseplane gets under Sensors.", color = Ink.muted, size = 13)
    }
}

@Composable
private fun Choice(text: String, on: Boolean, modifier: Modifier, onClick: () -> Unit) = Box(
    modifier.background(if (on) Ink.raise else Color.Transparent).clickable(onClick = onClick).padding(vertical = 12.dp),
    contentAlignment = Alignment.Center,
) { Text(text, color = if (on) Ink.text else Ink.muted, fontSize = 14.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal) }

/** A device already in Apple Home, Google Home, Alexa or its maker's app, shared with a code. */
@Composable
private fun SharedAdd(onAdded: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun add() = scope.launch {
        busy = true; error = null
        val r = runCatching { BoxHolder.addMatter(context, code.trim()) }
        busy = false
        r.exceptionOrNull()?.let { error = it.message ?: "Couldn't add it." }
        if (r.isSuccess) withContext(Dispatchers.Main) { onAdded() } // navigation is on the main thread
    }
    Body("Plugs, sensors and locks that work with Matter join this phone over Wi-Fi. Keep using them in the app they're in now; Senseplane only reads them.")
    CodeField(code, { code = it }, "3497-011-2332", "The 11 digits, or the text of its QR code (MT:…).")
    error?.let { StatusLine(it, Ink.warn) }
    Primary(if (busy) "Adding… this can take a minute" else "Add device", enabled = MatterPairing.looksLikeCode(code) && !busy) { add() }
    Panel {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Get a code", color = Ink.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Step(1, "In the app the device is in (Apple Home, Google Home, Alexa or the maker's app), open the device's settings.")
            Step(2, "Choose Turn on pairing mode, Share with another app or Linked Matter apps. You get an 11-digit code.")
            Step(3, "Enter it here within 15 minutes.")
        }
    }
    Body("The phone has to be on the same Wi-Fi as the device. Thread devices also need a Thread border router at home, such as a HomePod mini or Nest Hub.", color = Ink.muted, size = 13)
}

/** A new device: found over Bluetooth, given the Wi-Fi (or a Thread network), then added. */
@Composable
private fun BluetoothAdd(onAdded: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var ssid by remember { mutableStateOf(currentSsid(context)) }
    var password by remember { mutableStateOf("") }
    var dataset by remember { mutableStateOf("") }
    var thread by remember { mutableStateOf(false) }
    var state by remember { mutableStateOf<BlePairing>(BlePairing.Idle) }
    val busy = state is BlePairing.Working
    fun run() = scope.launch {
        var at: com.senseplane.app.box.BleStep? = null
        val r = runCatching {
            BoxHolder.addMatterOverBluetooth(context, code.trim(), ssid.trim(), password, if (thread) dataset else "") { step ->
                at = step
                state = BlePairing.Working(step)
            }
        }
        state = r.fold({ MatterPairing.added(it) }, { MatterPairing.failure(at, it.message) })
        (state as? BlePairing.Failed)?.needs?.let { if (it == Needs.Thread) thread = true }
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.all { it }) run()
        else state = BlePairing.Failed(null, "Senseplane needs the Nearby devices permission to find and pair the device over Bluetooth. Allow it in the phone's Settings > Apps > Senseplane.")
    }
    fun start() {
        val wanted = MatterPairing.permissions(Build.VERSION.SDK_INT)
        val missing = wanted.filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) run() else ask.launch(missing.toTypedArray())
    }

    Body("A device fresh from its box isn't on any network yet. The phone finds it over Bluetooth, checks it, and gives it your Wi-Fi.")
    CodeField(code, { code = it }, "MT:… or 3497-011-2332", "On the device, its box or its manual: scan its QR code, or type the 11 digits under it.")
    if (!thread) {
        Field("Wi-Fi network", ssid, { ssid = it }, placeholder = "Home", hint = "Most Matter devices join 2.4 GHz networks only.",
            error = if ((state as? BlePairing.Failed)?.needs == Needs.WiFi) "Enter the Wi-Fi the device should join." else null)
        Field("Wi-Fi password", password, { password = it }, password = true)
    } else {
        Field("Thread dataset", dataset, { dataset = it }, monoFont = true, placeholder = "0e08…",
            hint = "The active operational dataset in hex, from your Thread border router: in Home Assistant, Settings > Thread; on OpenThread, ot-ctl dataset active -x. Apple and Google border routers don't share theirs: add the device in Apple Home or Google Home, then share it here.")
    }
    Text(if (thread) "Use Wi-Fi instead" else "A Thread device (it says Thread on its box)? Use a Thread network", color = Ink.live, fontSize = 13.sp,
        modifier = Modifier.clickable(enabled = !busy) { thread = !thread })
    val canStart = MatterPairing.canStart(code, if (thread) "" else ssid, if (thread) dataset else "")
    Primary(
        when (state) {
            is BlePairing.Working -> "Pairing… keep the phone close"
            is BlePairing.Failed -> "Try again"
            else -> "Pair over Bluetooth"
        },
        enabled = canStart && !busy && state !is BlePairing.Added,
    ) { start() }
    if (state != BlePairing.Idle) {
        Panel {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                MatterPairing.progress(state).forEach { (step, s) -> Progress(step.label, s) }
            }
        }
    }
    when (val s = state) {
        is BlePairing.Failed -> StatusLine(s.message, Ink.warn)
        is BlePairing.Added -> {
            StatusLine("Added, with ${s.sensors} sensors. Choose what Senseplane gets under Sensors.", Ink.live)
            s.note?.let { Body(it, color = Ink.muted, size = 13) }
            Secondary("Done") { onAdded() }
        }
        else -> {}
    }
    Body("Keep the device within a few metres of the phone, and plugged in or with fresh batteries. If it has been on for a while, it may have left pairing mode: power it off and on again.", color = Ink.muted, size = 13)
}

/** The pairing code: typed, or read from its QR code with the camera. */
@Composable
private fun CodeField(code: String, onCode: (String) -> Unit, placeholder: String, hint: String) {
    val context = LocalContext.current
    var scanning by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) scanning = true else problem = "Senseplane needs the camera to read the QR code. You can type the code instead."
    }
    Field("Pairing code", code, onCode, placeholder = placeholder, monoFont = true, hint = hint)
    if (scanning) {
        QrScanner(onCode = { onCode(it); scanning = false }, onError = { problem = it; scanning = false })
        Secondary("Stop scanning") { scanning = false }
    } else {
        Secondary("Scan its QR code") {
            problem = null
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanning = true
            else askCamera.launch(Manifest.permission.CAMERA)
        }
    }
    problem?.let { StatusLine(it, Ink.warn) }
}

@Composable
private fun Progress(label: String, s: StepState) = Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
    val (mark, color) = when (s) {
        StepState.Done -> "✓" to Ink.live
        StepState.Now -> "…" to Ink.text
        StepState.Failed -> "!" to Ink.warn
        StepState.Todo -> "" to Ink.muted
    }
    Box(Modifier.size(22.dp).clip(CircleShape).background(Ink.raise), contentAlignment = Alignment.Center) { Text(mark, color = color, fontSize = 12.sp) }
    Text(label, color = if (s == StepState.Todo) Ink.muted else Ink.text, fontSize = 14.sp)
}

/** The Wi-Fi this phone is on, when Android tells (it needs location on newer phones; empty otherwise). */
private fun currentSsid(context: Context): String = runCatching {
    @Suppress("DEPRECATION")
    MatterPairing.ssid(context.applicationContext.getSystemService(WifiManager::class.java)?.connectionInfo?.ssid)
}.getOrDefault("")
