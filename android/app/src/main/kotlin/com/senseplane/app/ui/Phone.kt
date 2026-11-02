// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.ui

import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.senseplane.app.Prefs
import com.senseplane.app.box.BoxHolder
import com.senseplane.app.box.BoxService
import com.senseplane.app.box.BoxStatus
import com.senseplane.app.box.CameraState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The phone's own camera, and the IP cameras it relays. */
private fun BoxStatus.phoneCamera(prefs: Prefs): CameraState? =
    if (!prefs.camera) null else cameras.firstOrNull { it.sourceId == phoneCamera } ?: CameraState(phoneCamera ?: "", "connecting")
private fun BoxStatus.ipCameras(prefs: Prefs): List<CameraState> = cameras.filter { it.sourceId != phoneCamera }

fun stateText(c: CameraState?): Pair<String, androidx.compose.ui.graphics.Color> = when (c?.state) {
    "online" -> "Online" to Ink.live
    "connecting" -> "Connecting…" to Ink.muted
    "reconnecting" -> ("Reconnecting" + (c.detail?.let { " · $it" } ?: "")) to Ink.warn
    "offline" -> ("Offline" + (c.detail?.let { " · $it" } ?: "")) to Ink.warn
    else -> "Starting…" to Ink.muted
}

@Composable
fun HomeScreen(go: (String) -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val status by BoxHolder.status.collectAsState()
    Screen(bottom = {
        Secondary(if (prefs.session.isEmpty()) "Sign in to chat and manage watches" else "Chat and manage") { go(if (prefs.session.isEmpty()) "signin" else "manage") }
    }) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 12.dp)) {
            Column(Modifier.weight(1f)) {
                Text(prefs.phoneName, color = Ink.text, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                Text(prefs.server.removePrefix("https://").removePrefix("http://"), color = Ink.muted, fontSize = 12.sp, fontFamily = mono)
            }
            Text("Settings", color = Ink.live, fontSize = 14.sp, modifier = Modifier.clickable { go("settings") }.padding(12.dp))
        }
        StatusLine(
            when {
                status.running -> "Running in the background"
                status.pairing -> "Waiting to be connected: code ${status.code ?: "…"}"
                else -> "Stopped"
            },
            if (status.running) Ink.live else Ink.warn,
        )
        if (prefs.camera) {
            Label("This phone")
            Panel {
                val (text, color) = stateText(status.phoneCamera(prefs))
                NavRow("Camera", text, color, dot = color) { go("camera") }
            }
        }
        if (prefs.bridge) {
            val ip = status.ipCameras(prefs)
            Label("IP cameras relayed · ${ip.size}")
            if (ip.isNotEmpty()) Panel {
                ip.forEachIndexed { i, c ->
                    if (i > 0) Divider()
                    val (text, color) = stateText(c)
                    NavRow("Camera ${i + 1}", text, color, dot = color) { go("cameradetail/${c.sourceId}") }
                }
            }
            Secondary("Add an IP camera" + if (status.found > 0) " · ${status.found} found" else "") { go("addcamera") }
            Label("Sensors")
            Panel {
                NavRow(if (status.sensors == 0) "None nearby yet" else "${status.sending} sent of ${status.sensors} nearby", "This phone and Bluetooth sensors") { go("sensors") }
            }
        }
    }
}

/** The camera, live on the screen; dimming keeps it sending with the screen black. */
@Composable
fun CameraScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val status by BoxHolder.status.collectAsState()
    var dim by remember { mutableStateOf(false) }
    val (text, color) = stateText(status.phoneCamera(prefs))
    // Keep the screen on while it shows the camera; dimmed, the screen is black.
    DisposableEffect(Unit) {
        val w = (context as ComponentActivity).window
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); w.attributes = w.attributes.apply { screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE } }
    }
    if (dim) {
        DisposableEffect(Unit) {
            val w = (context as ComponentActivity).window
            w.attributes = w.attributes.apply { screenBrightness = 0.01f }
            onDispose { w.attributes = w.attributes.apply { screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE } }
        }
        Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black).clickable { dim = false }, contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) { Dot(color); Spacer(Modifier.width(8.dp)); Text(text, color = Ink.muted, fontSize = 13.sp) }
                Text("Tap to wake", color = androidx.compose.ui.graphics.Color(0xFF55555C), fontSize = 12.sp)
            }
        }
        return
    }
    Screen("Camera", onBack = onBack, bottom = {
        Primary("Dim the screen") { dim = true }
    }) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp)).background(Ink.raise)) {
            if (BoxService.instance != null) CameraPreview()
            Row(Modifier.align(Alignment.BottomStart).padding(10.dp).clip(RoundedCornerShape(6.dp)).background(androidx.compose.ui.graphics.Color(0x990A0A0B)).padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Dot(color, 6); Spacer(Modifier.width(6.dp)); Text(text, color = Ink.text, fontSize = 12.sp)
            }
        }
        val paused by BoxService.paused.collectAsState()
        paused?.let { StatusLine("$it. Allow it in Settings to send over mobile data.", Ink.warn) }
        Body("Senseplane gets this camera as \"${prefs.phoneName}\", in 720p. It keeps sending with the screen dimmed or off, while the notification shows.")
        Body("A phone gets warm sending video all day: keep it plugged in and out of the sun. When it's warm it sends fewer frames until it cools.", color = Ink.muted, size = 13)
    }
}

@Composable
private fun CameraPreview() = AndroidView(factory = { ctx ->
    SurfaceView(ctx).apply {
        holder.setFixedSize(1280, 720)
        holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(h: SurfaceHolder) { BoxService.instance?.setPreview(h.surface) }
            override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, ht: Int) = Unit
            override fun surfaceDestroyed(h: SurfaceHolder) { BoxService.instance?.setPreview(null) }
        })
    }
}, modifier = Modifier.fillMaxSize())

@Composable
fun CameraDetailScreen(sourceId: String, onBack: () -> Unit) {
    val status by BoxHolder.status.collectAsState()
    val cam = status.cameras.firstOrNull { it.sourceId == sourceId }
    val (text, color) = stateText(cam)
    Screen("IP camera", onBack = onBack) {
        StatusLine(text, color)
        Panel {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("In Senseplane", color = Ink.muted, fontSize = 12.sp)
                Text(sourceId, color = Ink.text, fontSize = 14.sp, fontFamily = mono)
            }
        }
        Body("This phone pulls the camera's stream on your Wi-Fi and sends it on as it is, without re-encoding. Rename it, set its zones or remove it in Senseplane.", color = Ink.muted, size = 13)
    }
}

@Composable
fun SettingsScreen(onBack: () -> Unit, onForgotten: () -> Unit, go: (String) -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val scope = rememberCoroutineScope()
    var camera by remember { mutableStateOf(prefs.camera) }
    var bridge by remember { mutableStateOf(prefs.bridge) }
    var videoOnMobile by remember { mutableStateOf(prefs.videoOnMobile) }
    val status by BoxHolder.status.collectAsState()
    fun restart() { BoxHolder.stop(context); BoxHolder.start(context) }
    Screen("Settings", onBack = onBack) {
        Panel {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Server", color = Ink.muted, fontSize = 12.sp)
                Text(prefs.server, color = Ink.text, fontSize = 14.sp, fontFamily = mono)
            }
        }
        Panel {
            ToggleRow("Be a camera", "Sends this phone's back camera.", camera) { camera = it; prefs.camera = it; restart() }
            Divider()
            ToggleRow("Relay cameras and sensors", "IP cameras on this Wi-Fi and Bluetooth sensors.", bridge) { bridge = it; prefs.bridge = it; restart() }
            Divider()
            ToggleRow("Send video on mobile data", "Off: only on Wi-Fi. A camera uses about 20 GB a day.", videoOnMobile) { videoOnMobile = it; prefs.videoOnMobile = it; restart() }
        }
        Panel {
            if (status.running || status.pairing) NavRow("Stop Senseplane on this phone", "It stops sending until you start it again") { BoxHolder.stop(context) }
            else NavRow("Start Senseplane", null) { BoxHolder.start(context) }
        }
        Secondary("Disconnect this phone") {
            scope.launch {
                BoxHolder.forget(context)
                prefs.onboarded = false
                onForgotten()
            }
        }
        Body("Disconnecting removes this phone's link to Senseplane; it shows a new code to connect again. What it already sent stays in Senseplane.", color = Ink.muted, size = 13)
        if (prefs.session.isNotEmpty()) Secondary("Chat and manage") { go("manage") }
    }
}
