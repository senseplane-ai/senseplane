// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.senseplane.app.Prefs
import com.senseplane.app.api.Api
import com.senseplane.app.api.Event
import com.senseplane.app.api.Message
import com.senseplane.app.api.Source
import com.senseplane.app.api.Watch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.TimeZone

fun api(prefs: Prefs) = Api(prefs.server, prefs.session)

private val clock = DateTimeFormatter.ofPattern("EEE HH:mm").withZone(ZoneId.systemDefault())
fun timeText(iso: String) = runCatching { clock.format(Instant.parse(iso)) }.getOrDefault(iso)

fun eventKind(type: String) = when {
    type == "watch.triggered" -> "Watch fired"
    type == "watch.unchecked" -> "Couldn't check"
    type.startsWith("detection.") -> type.removePrefix("detection.").replaceFirstChar { it.uppercase() }.replace('_', ' ')
    else -> type.substringAfterLast('.').replaceFirstChar { it.uppercase() }.replace('_', ' ')
}

@Composable
fun SignInScreen(onBack: () -> Unit, onSignedIn: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    Screen("Sign in to manage", onBack = onBack, bottom = {
        Primary(if (busy) "Signing in…" else "Sign in", enabled = email.contains('@') && password.isNotEmpty() && !busy) {
            scope.launch {
                busy = true; error = null
                runCatching { Api(prefs.server).signIn(email, password) }
                    .onSuccess { prefs.session = it.session; onSignedIn() }
                    .onFailure { error = it.message }
                busy = false
            }
        }
    }) {
        Body("Owners and admins can chat with Senseplane, see what happened, set watches and switch devices from this phone. The camera and sensors keep working without signing in.")
        Field("Email", email, { email = it }, keyboard = KeyboardType.Email)
        Field("Password", password, { password = it }, password = true, error = error)
    }
}

private val tabs = listOf("Chat", "Activity", "Cameras", "Devices", "Watches", "More")

/** The signed-in area: requests waiting for a person on top, then the tabs, and a bottom bar. */
@Composable
fun ManageScreen(go: (String) -> Unit, onSignedOut: () -> Unit) {
    var tab by rememberSaveable { mutableStateOf("Chat") }
    Column(Modifier.fillMaxSize().background(Ink.bg).statusBarsPadding()) {
        ConfirmationsBar()
        Box(Modifier.weight(1f)) {
            when (tab) {
                "Chat" -> ChatTab()
                "Activity" -> ActivityTab(go)
                "Cameras" -> CamerasTab()
                "Devices" -> DevicesTab()
                "Watches" -> WatchesTab(go)
                else -> MoreTab(go, onSignedOut)
            }
        }
        Row(Modifier.fillMaxWidth().background(Ink.panel).border(1.dp, Ink.line).navigationBarsPadding()) {
            tabs.forEach { t ->
                Box(Modifier.weight(1f).heightIn(min = 56.dp).clickable { tab = t }.semantics { role = Role.Tab; selected = tab == t }, contentAlignment = Alignment.Center) {
                    Text(t, color = if (tab == t) Ink.live else Ink.muted, fontSize = 13.sp, fontWeight = if (tab == t) FontWeight.SemiBold else FontWeight.Normal)
                }
            }
        }
    }
}

@Composable
private fun ChatTab() {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val scope = rememberCoroutineScope()
    val messages = remember { mutableStateListOf<Message>() }
    var conversation by rememberSaveable { mutableStateOf<String?>(null) }
    var question by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun ask() = scope.launch {
        val q = question.trim()
        if (q.isEmpty()) return@launch
        busy = true; error = null; question = ""
        messages.add(Message("local-${messages.size}", "user", q))
        runCatching {
            val a = api(prefs)
            val c = conversation ?: a.newConversation().id.also { conversation = it }
            a.ask(c, q, TimeZone.getDefault().id)
        }.onSuccess { messages.add(it) }.onFailure { error = it.message }
        busy = false
    }
    Screen("Chat", bottom = {
        Field("Ask about your cameras and sensors", question, { question = it }, placeholder = "Has the fridge been opened today?")
        Primary(if (busy) "Thinking…" else "Ask", enabled = question.isNotBlank() && !busy) { ask() }
    }) {
        if (messages.isEmpty()) Body("Ask what happened, how long something took, or what's going on right now.", color = Ink.muted)
        messages.forEach { m ->
            val mine = m.role == "user"
            Box(Modifier.fillMaxWidth(), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
                Column(Modifier.widthIn(max = 300.dp).clip(RoundedCornerShape(12.dp)).background(if (mine) Ink.raise else Ink.panel).padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(m.content, color = Ink.text, fontSize = 15.sp, lineHeight = 21.sp)
                    m.moments.forEachIndexed { i, mo -> Text("[${i + 1}] ${mo.sourceName ?: ""} ${mo.at?.let(::timeText) ?: ""}", color = Ink.live, fontSize = 12.sp) }
                }
            }
        }
        error?.let { StatusLine(it, Ink.warn) }
    }
}

@Composable
private fun ActivityTab(go: (String) -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val events by produceState<Result<List<Event>>?>(null) { value = runCatching { api(prefs).events() } }
    Screen("Activity") {
        when (val r = events) {
            null -> Body("Loading…", color = Ink.muted)
            else -> r.onFailure { StatusLine(it.message ?: "Couldn't load.", Ink.warn) }.onSuccess { list ->
                if (list.isEmpty()) Body("Nothing yet.", color = Ink.muted)
                else Panel {
                    list.forEachIndexed { i, e ->
                        if (i > 0) Divider()
                        NavRow(e.summary.ifBlank { eventKind(e.type) }, "${eventKind(e.type)} · ${e.source?.name ?: ""} · ${timeText(e.occurredAt)}") { go("event/${e.id}") }
                    }
                }
            }
        }
    }
}

@Composable
fun EventScreen(id: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val event by produceState<Result<Event>?>(null, id) { value = runCatching { api(prefs).event(id) } }
    Screen("Event", onBack = onBack) {
        event?.onFailure { StatusLine(it.message ?: "Couldn't load.", Ink.warn) }?.onSuccess { e ->
            e.media?.snapshotUrl?.let { RemoteImage(it) }
            Text(e.summary.ifBlank { eventKind(e.type) }, color = Ink.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, lineHeight = 24.sp)
            Body("${eventKind(e.type)} · ${e.source?.name ?: ""} · ${timeText(e.occurredAt)}", color = Ink.muted, size = 13)
            if (e.type == "watch.triggered" && e.verified == false) Body("Not checked by a model.", color = Ink.warn, size = 13)
        } ?: Body("Loading…", color = Ink.muted)
    }
}

/** A picture by URL (event snapshots are signed links). */
@Composable
fun RemoteImage(url: String) {
    val bitmap by produceState<Bitmap?>(null, url) {
        value = withContext(Dispatchers.IO) {
            runCatching { Api.defaultClient.newCall(Request.Builder().url(url).build()).execute().use { BitmapFactory.decodeStream(it.body?.byteStream()) } }.getOrNull()
        }
    }
    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp)).background(Ink.raise)) {
        bitmap?.let { Image(it.asImageBitmap(), contentDescription = "Snapshot", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
    }
}

@Composable
private fun CamerasTab() {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val sources by produceState<Result<List<Source>>?>(null) { value = runCatching { api(prefs).sources() } }
    Screen("All cameras and sensors") {
        sources?.onFailure { StatusLine(it.message ?: "Couldn't load.", Ink.warn) }?.onSuccess { list ->
            if (list.isEmpty()) Body("No cameras yet.", color = Ink.muted)
            else Panel {
                list.sortedBy { if (it.status == "online") 0 else 1 }.forEachIndexed { i, s ->
                    if (i > 0) Divider()
                    val color = if (s.status == "online") Ink.live else if (s.status == "offline" || s.status == "reconnecting") Ink.warn else Ink.muted
                    Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(s.name, color = Ink.text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                            Text(listOfNotNull(s.location, s.senses.joinToString(", ")).joinToString(" · "), color = Ink.muted, fontSize = 12.sp)
                        }
                        Dot(color)
                    }
                }
            }
        } ?: Body("Loading…", color = Ink.muted)
    }
}

@Composable
private fun WatchesTab(go: (String) -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val watches by produceState<Result<List<Watch>>?>(null) { value = runCatching { api(prefs).watches() } }
    Screen("Watches", bottom = { Primary("New watch") { go("newwatch") } }) {
        watches?.onFailure { StatusLine(it.message ?: "Couldn't load.", Ink.warn) }?.onSuccess { list ->
            if (list.isEmpty()) Body("No watches yet. A watch tells you when something happens, in plain words: \"Tell me if the fridge hasn't been opened by 10am\".", color = Ink.muted)
            else Panel {
                list.forEachIndexed { i, w ->
                    if (i > 0) Divider()
                    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(w.instruction, color = Ink.text, fontSize = 15.sp)
                        Text(w.status.replaceFirstChar { it.uppercase() }, color = if (w.status == "active") Ink.live else Ink.muted, fontSize = 12.sp)
                    }
                }
            }
        } ?: Body("Loading…", color = Ink.muted)
    }
}

@Composable
fun NewWatchScreen(onBack: () -> Unit, onCreated: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val scope = rememberCoroutineScope()
    var instruction by remember { mutableStateOf("") }
    val picked = remember { mutableStateListOf<String>() }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val sources by produceState<List<Source>>(emptyList()) { value = runCatching { api(prefs).sources() }.getOrDefault(emptyList()) }
    Screen("New watch", onBack = onBack, bottom = {
        Primary(if (busy) "Starting…" else "Start watching", enabled = instruction.length >= 3 && picked.isNotEmpty() && !busy) {
            scope.launch {
                busy = true; error = null
                runCatching { api(prefs).createWatch(instruction, picked.toList()) }.onSuccess { onCreated() }.onFailure { error = it.message }
                busy = false
            }
        }
    }) {
        Field("What should Senseplane watch for?", instruction, { instruction = it }, placeholder = "Tell me if the garage door is left open for 10 minutes", error = error)
        Label("On")
        Panel {
            sources.forEachIndexed { i, s ->
                if (i > 0) Divider()
                ToggleRow(s.name, s.location, s.id in picked) { on -> if (on) picked.add(s.id) else picked.remove(s.id) }
            }
        }
    }
}

@Composable
private fun MoreTab(go: (String) -> Unit, onSignedOut: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val scope = rememberCoroutineScope()
    Screen("More") {
        Panel {
            NavRow("This phone", "Its camera, IP cameras and sensors") { go("home") }
            Divider()
            NavRow("Settings", null) { go("settings") }
        }
        Body("Agents, team and webhooks are in Senseplane on a computer.", color = Ink.muted, size = 13)
        Secondary("Sign out") {
            scope.launch {
                api(prefs).signOut()
                prefs.session = ""
                onSignedOut()
            }
        }
    }
}
