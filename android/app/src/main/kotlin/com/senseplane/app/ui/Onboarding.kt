// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.senseplane.app.Prefs
import com.senseplane.app.R
import com.senseplane.app.box.BoxHolder

@Composable
fun WelcomeScreen(onStart: () -> Unit) = Screen(bottom = { Primary("Get started", onClick = onStart) }) {
    Spacer(Modifier.height(80.dp))
    Icon(painterResource(R.drawable.ic_launcher_fg), contentDescription = null, tint = Ink.live, modifier = Modifier.size(96.dp))
    Text("Eyes and ears for your agents", color = Ink.text, fontSize = 28.sp, fontWeight = FontWeight.SemiBold, lineHeight = 34.sp)
    Body("Turn this phone into a camera for Senseplane, or keep it at home to relay your IP cameras and sensors. Your agents can then see, listen and get told when something happens.", size = 16)
}

/** The server, then the code this phone shows until someone connects it in Senseplane. */
@Composable
fun PairScreen(onBack: () -> Unit, onPaired: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    var server by remember { mutableStateOf(prefs.server.ifEmpty { "https://" }) }
    var started by remember { mutableStateOf(prefs.server.isNotEmpty()) }
    val status by BoxHolder.status.collectAsState()
    LaunchedEffect(started) {
        if (started) BoxHolder.start(context)
    }
    LaunchedEffect(status.state) {
        if (started && status.running) onPaired()
    }
    if (!started) {
        val valid = Regex("^https?://[^/\\s]+").containsMatchIn(server.trim())
        Screen("Pair with your server", onBack = onBack, bottom = {
            Primary("Continue", enabled = valid) {
                prefs.server = server
                started = true
            }
        }) {
            Field("Server", server, { server = it }, placeholder = "https://senseplane.example.com", monoFont = true, keyboard = KeyboardType.Uri,
                hint = "The address you open Senseplane at.")
            if (server.trim().startsWith("http://")) Body("Plain http only works on your own network; use https for anything else.", color = Ink.warn, size = 13)
        }
        return
    }
    Screen("Pair with your server", onBack = { BoxHolder.stop(context); started = false }, bottom = {
        status.link?.let { link ->
            Primary("Share the link") {
                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link), "Send the link"))
            }
        }
        Secondary("Open it on this phone", enabled = status.link != null) { status.link?.let { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) } }
    }) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Ink.panel).padding(12.dp)) {
            Column {
                Text("Server", color = Ink.muted, fontSize = 12.sp)
                Text(prefs.server, color = Ink.text, fontSize = 14.sp, fontFamily = mono)
            }
        }
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Ink.raise).border(1.dp, Ink.line, RoundedCornerShape(16.dp)).padding(vertical = 28.dp, horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Enter this code in Senseplane", color = Ink.soft, fontSize = 14.sp)
            Text(status.code ?: "····-····", color = Ink.text, fontSize = 40.sp, fontFamily = mono, letterSpacing = 3.sp,
                modifier = Modifier.semantics { contentDescription = "Pairing code ${status.code ?: "not yet"}" })
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Dot(if (status.error != null) Ink.warn else Ink.warn)
                Text(status.error ?: if (status.code == null) "Getting a code…" else "Waiting for you to connect it · works 15 min", color = Ink.muted, fontSize = 13.sp)
            }
        }
        Text("How to connect it", color = Ink.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Step(1, "On a computer, open Senseplane and go to Cameras → Add camera → Enter a code.")
        Step(2, "Type the code and connect. This phone carries on by itself; you never paste a token.")
    }
}

/** What this phone does: send its camera, relay IP cameras and sensors, or both. */
@Composable
fun ModeScreen(onBack: () -> Unit, onNext: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    var camera by remember { mutableStateOf(prefs.camera) }
    var bridge by remember { mutableStateOf(prefs.bridge) }
    var name by remember { mutableStateOf(prefs.phoneName) }
    Screen("What this phone does", onBack = onBack, bottom = {
        Primary("Continue", enabled = (camera || bridge) && name.isNotBlank()) {
            prefs.camera = camera; prefs.bridge = bridge; prefs.phoneName = name
            onNext()
        }
    }) {
        Field("Name", name, { name = it }, placeholder = "Hallway phone", hint = "What you'll see in Senseplane.")
        Panel {
            ToggleRow("Be a camera", "Sends this phone's back camera, even with the screen off.", camera) { camera = it }
            Divider()
            ToggleRow("Relay cameras and sensors", "Finds IP cameras on this Wi-Fi and listens for Bluetooth sensors. Keep the phone plugged in.", bridge) { bridge = it }
        }
        Body("You can change this later in Settings.", color = Ink.muted, size = 13)
    }
}

@Composable
fun PermissionsScreen(onBack: () -> Unit, onDone: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val wanted = buildList {
        if (prefs.camera) add(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        if (prefs.bridge) add(if (Build.VERSION.SDK_INT >= 31) Manifest.permission.BLUETOOTH_SCAN else Manifest.permission.ACCESS_FINE_LOCATION)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        prefs.onboarded = true
        // Restart so the service picks up what was granted (the camera, Bluetooth).
        BoxHolder.stop(context)
        BoxHolder.start(context)
        onDone()
    }
    Screen("Permissions", onBack = onBack, bottom = { Primary("Allow") { ask.launch(wanted.toTypedArray()) } }) {
        Body("Senseplane asks only for what this phone does:")
        Panel {
            if (prefs.camera) {
                PermRow("Camera", "To send what the camera sees. Nothing is recorded on the phone.")
                Divider()
            }
            PermRow("Notifications", "Android shows one while Senseplane runs, so you always know.")
            if (prefs.bridge) {
                Divider()
                PermRow("Nearby devices", "To hear Bluetooth sensors. Never used to find where you are.")
            }
        }
        Body("Finding cameras on your Wi-Fi needs no permission.", color = Ink.muted, size = 13)
    }
}

@Composable
private fun PermRow(title: String, why: String) = Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
    Text(title, color = Ink.text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
    Text(why, color = Ink.muted, fontSize = 13.sp, lineHeight = 19.sp)
}
