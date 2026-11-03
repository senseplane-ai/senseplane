// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.senseplane.app.Prefs
import com.senseplane.app.api.ApiException
import com.senseplane.app.api.Device
import com.senseplane.app.api.DeviceCommand
import com.senseplane.app.api.actionLabel
import com.senseplane.app.api.actionWords
import com.senseplane.app.api.askText
import com.senseplane.app.api.commandPending
import com.senseplane.app.api.commandText
import com.senseplane.app.api.commandWorked
import com.senseplane.app.api.num
import com.senseplane.app.api.stateText
import com.senseplane.app.box.BoxService
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** What a device answered last, shown under it. */
private data class Answer(val text: String, val good: Boolean)

/** A command waiting for the person to confirm it in a dialog. */
private data class Ask(val device: Device, val action: String, val value: Any? = null)

/** The buttons a device gets, besides on/off and the steppers. */
private val buttonActions = listOf("open", "close", "lock", "unlock", "arm_home", "arm_away", "disarm")

/**
 * Lights, switches, locks, covers, thermostats and alarms a person can switch
 * from here. Nothing switches on its own: every command is this person's tap.
 * Secure devices (locks, garage doors, gates, alarms) ask "are you sure" first.
 */
@Composable
fun DevicesTab() {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val scope = rememberCoroutineScope()
    val devices = remember { mutableStateListOf<Device>() }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val busy = remember { mutableStateMapOf<String, Boolean>() }
    val answers = remember { mutableStateMapOf<String, Answer>() }
    var asking by remember { mutableStateOf<Ask?>(null) }

    suspend fun refresh() {
        runCatching { api(prefs).devices() }
            .onSuccess { devices.clear(); devices.addAll(it); error = null }
            .onFailure { if (!loaded) error = it.message }
        loaded = true
    }

    fun send(d: Device, action: String, value: Any?, confirm: Boolean) = scope.launch {
        busy[d.id] = true
        answers.remove(d.id)
        val a = api(prefs)
        runCatching {
            var c = a.command(d.id, action, value, confirm)
            // Sent but no answer yet: look again for a little while.
            var tries = 0
            while (commandPending(c) && tries++ < 8) { delay(2000); c = runCatching { a.deviceCommand(c.id) }.getOrDefault(c) }
            c
        }.onSuccess { c ->
            answers[d.id] = Answer(commandText(c), commandWorked(c))
        }.onFailure { e ->
            if (e is ApiException && e.code == "confirmation_required") asking = Ask(d, action, value)
            else answers[d.id] = Answer(e.message ?: "Couldn't send that.", false)
        }
        refresh()
        busy[d.id] = false
    }

    fun act(d: Device, action: String, value: Any? = null) {
        if (d.tier == "secure") asking = Ask(d, action, value) else send(d, action, value, confirm = false)
    }

    // Fresh state while the tab is showing (other people and agents switch things too).
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) { refresh(); delay(10_000) }
        }
    }

    Screen("Devices") {
        when {
            !loaded -> Body("Loading…", color = Ink.muted)
            error != null -> StatusLine(error ?: "", Ink.warn)
            devices.isEmpty() -> Body("No devices yet. Lights, switches, locks and covers show up here once the box lists them and you choose them in Senseplane.", color = Ink.muted)
            else -> {
                Body("Senseplane switches these only when you, or an agent you allowed, asks. Locks, garage doors, gates and alarms ask you to confirm first.", color = Ink.muted, size = 13)
                Panel {
                    devices.forEachIndexed { i, d ->
                        if (i > 0) Divider()
                        DeviceRow(d, busy[d.id] == true, answers[d.id]) { action, value -> act(d, action, value) }
                    }
                }
            }
        }
    }

    asking?.let { ask ->
        val words = actionWords(ask.action, ask.device.name, ask.value?.let { if (it is Double) num(it) else it.toString() })
        ConfirmDialog(
            title = words.replaceFirstChar { it.uppercase() } + "?",
            text = "This is a ${ask.device.type.replace('_', ' ')}. Check that it's safe before you go ahead.",
            yes = actionLabel(ask.action),
            onYes = { asking = null; send(ask.device, ask.action, ask.value, confirm = true) },
            onNo = { asking = null },
        )
    }
}

@Composable
private fun DeviceRow(d: Device, busy: Boolean, answer: Answer?, act: (String, Any?) -> Unit) {
    val s = d.state
    val usable = d.controllable && d.online && d.canControl && !busy
    val sub = listOfNotNull(d.room, if (d.online) stateText(d) else "Offline").joinToString(" · ")
    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        if ("turn_on" in d.actions && "turn_off" in d.actions && d.controllable) {
            ToggleRow(d.name, sub, s?.on == true, enabled = usable) { on -> act(if (on) "turn_on" else "turn_off", null) }
        } else {
            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(d.name, color = Ink.text, fontSize = 15.sp)
                Text(sub, color = Ink.muted, fontSize = 12.sp)
            }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            when {
                !d.controllable -> Note("Not set up for control. An admin can allow it in Senseplane on a computer.")
                !d.online -> Note("Its box isn't reporting, so it can't be switched right now.")
                !d.canControl -> Note("You can see this one but not switch it.")
            }
            if (d.controllable) {
                if ("set_brightness" in d.actions) {
                    val b = s?.brightness ?: if (s?.on == true) 100.0 else 0.0
                    Stepper("Brightness ${num(b)}%", usable,
                        down = { act("set_brightness", ((b - 10) / 10).roundToInt().times(10).coerceIn(0, 100)) },
                        up = { act("set_brightness", ((b + 10) / 10).roundToInt().times(10).coerceIn(0, 100)) })
                }
                if ("set_temperature" in d.actions) {
                    val t = s?.targetTemperature ?: 20.0
                    Stepper("Set to ${num(t)} °C", usable,
                        down = { act("set_temperature", (t - 0.5).coerceIn(10.0, 28.0)) },
                        up = { act("set_temperature", (t + 0.5).coerceIn(10.0, 28.0)) })
                }
                val buttons = buttonActions.filter { it in d.actions }
                if (buttons.isNotEmpty()) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    buttons.forEach { a -> Secondary(actionLabel(a), enabled = usable, modifier = Modifier.weight(1f)) { act(a, null) } }
                }
            }
            if (busy) Note("Asking ${d.name}…")
            answer?.let { Text(it.text, color = if (it.good) Ink.live else Ink.warn, fontSize = 13.sp, lineHeight = 18.sp) }
        }
    }
}

@Composable
private fun Note(text: String) = Text(text, color = Ink.muted, fontSize = 12.sp, lineHeight = 17.sp)

@Composable
private fun Stepper(label: String, enabled: Boolean, down: () -> Unit, up: () -> Unit) = Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    Secondary("−", enabled = enabled, modifier = Modifier.widthIn(max = 64.dp), onClick = down)
    Text(label, color = Ink.soft, fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
    Secondary("+", enabled = enabled, modifier = Modifier.widthIn(max = 64.dp), onClick = up)
}

@Composable
private fun ConfirmDialog(title: String, text: String, yes: String, onYes: () -> Unit, onNo: () -> Unit) = AlertDialog(
    onDismissRequest = onNo,
    containerColor = Ink.raise,
    title = { Text(title, color = Ink.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
    text = { Text(text, color = Ink.soft, fontSize = 14.sp, lineHeight = 20.sp) },
    confirmButton = { TextButton(onClick = onYes) { Text(yes, color = Ink.live, fontWeight = FontWeight.SemiBold) } },
    dismissButton = { TextButton(onClick = onNo) { Text("Cancel", color = Ink.soft) } },
)

/**
 * Requests waiting for a person (an agent asks to unlock the front door),
 * at the top of the signed-in area with Approve and Deny. Checked every few
 * seconds while the app is on screen; the box service notifies otherwise.
 */
@Composable
fun ConfirmationsBar() {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val scope = rememberCoroutineScope()
    val pending = remember { mutableStateListOf<DeviceCommand>() }
    var deciding by remember { mutableStateOf<String?>(null) }
    var answer by remember { mutableStateOf<Answer?>(null) }

    suspend fun refresh() {
        // Members and up can confirm; for anyone else this answers 403 and the bar stays empty.
        runCatching { api(prefs).confirmations() }.onSuccess {
            pending.clear(); pending.addAll(it)
            BoxService.shownConfirmations(it.map { c -> c.id })
        }
    }

    fun decide(c: DeviceCommand, approve: Boolean) = scope.launch {
        deciding = c.id
        runCatching { api(prefs).decide(c.id, approve) }
            .onSuccess { answer = Answer(commandText(it), commandWorked(it) || it.status == "denied") }
            .onFailure { answer = Answer(it.message ?: "Couldn't send that.", false) }
        deciding = null
        refresh()
    }

    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            BoxService.confirmationsOnScreen = true
            try {
                while (true) { refresh(); delay(4_000) }
            } finally {
                BoxService.confirmationsOnScreen = false
            }
        }
    }

    if (pending.isEmpty() && answer == null) return
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        pending.forEach { c ->
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Ink.panel).border(1.dp, Ink.warn, RoundedCornerShape(12.dp)).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(askText(c), color = Ink.text, fontSize = 15.sp, fontWeight = FontWeight.Medium, lineHeight = 21.sp)
                c.expiresAt?.let { Text("It runs only if someone approves it by ${timeText(it)}.", color = Ink.muted, fontSize = 12.sp) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val free = deciding == null
                    Secondary("Deny", enabled = free, modifier = Modifier.weight(1f)) { decide(c, false) }
                    Primary(if (deciding == c.id) "Sending…" else "Approve", enabled = free, modifier = Modifier.weight(1f)) { decide(c, true) }
                }
            }
        }
        answer?.let { a ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(a.text, color = if (a.good) Ink.live else Ink.warn, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = { answer = null }) { Text("OK", color = Ink.soft) }
            }
        }
    }
}
