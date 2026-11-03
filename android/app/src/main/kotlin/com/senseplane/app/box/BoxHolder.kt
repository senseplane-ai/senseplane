// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.senseplane.app.Prefs
import com.senseplane.go.mobile.Box
import com.senseplane.go.mobile.LineWriter
import com.senseplane.go.mobile.Listener
import com.senseplane.go.mobile.MatterSteps
import com.senseplane.go.mobile.Mobile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.io.File

/**
 * The phone's box (bridge/mobile, ADR 0064): one per app, made for the
 * server in Prefs. The service keeps it running; screens read its status
 * and ask it to add cameras or choose sensors.
 */
object BoxHolder {
    private var box: Box? = null
    private var server = ""
    private val _status = MutableStateFlow(BoxStatus())
    val status: StateFlow<BoxStatus> = _status

    /** The box for the server in Prefs, made on first use (or again when the server changed). */
    @Synchronized
    fun get(context: Context): Box {
        val prefs = Prefs(context)
        val current = box
        if (current != null && server == prefs.server) return current
        current?.stop()
        val dir = File(context.filesDir, "box").apply { mkdirs() }
        val b = Mobile.newBox(prefs.server, dir.path, prefs.phoneName, object : Listener {
            override fun onStatus(statusJSON: String) {
                _status.value = parseStatus(statusJSON)
            }
        })
        b.setLogger(object : LineWriter {
            override fun writeLine(line: String) {
                Log.i("SenseplaneBox", line)
            }
        })
        // Agents' and watches' messages for this phone's camera play here (ADR 0069).
        b.setSpeaker(PhoneSpeaker(volume = PhoneSpeaker.mediaVolume(context.applicationContext)))
        if (prefs.whipBase.isNotEmpty()) b.setWHIPBase(prefs.whipBase)
        if (prefs.matterAddress.isNotEmpty()) runCatching { b.setMatterAddress(prefs.matterAddress) }
        b.setMatterStrictRevocation(prefs.matterStrictRevocation)
        box = b
        server = prefs.server
        return b
    }

    fun start(context: Context) {
        ContextCompat.startForegroundService(context, Intent(context, BoxService::class.java))
    }

    fun stop(context: Context) {
        context.stopService(Intent(context, BoxService::class.java))
    }

    /** Unpairs this phone; it shows a new code when started again. */
    suspend fun forget(context: Context) = withContext(Dispatchers.IO) {
        stop(context)
        get(context).forget()
        _status.value = BoxStatus()
    }

    suspend fun found(context: Context): List<FoundCamera> = withContext(Dispatchers.IO) { parseFound(get(context).foundCameras()) }

    suspend fun search(context: Context): Long = withContext(Dispatchers.IO) { get(context).searchCameras() }

    suspend fun addFound(context: Context, id: String, user: String, pass: String, name: String): String =
        withContext(Dispatchers.IO) { get(context).addFoundCamera(id, user, pass, name) }

    suspend fun addByAddress(context: Context, url: String, name: String): String =
        withContext(Dispatchers.IO) { get(context).addCameraByAddress(url, name) }

    suspend fun sensors(context: Context): List<Sensor> = withContext(Dispatchers.IO) { parseSensors(get(context).sensors()) }

    suspend fun choose(context: Context, entityId: String, on: Boolean) = withContext(Dispatchers.IO) { get(context).choose(entityId, on) }

    /** Strict revocation (ADR 0073): kept, and applied to the next Matter device added. */
    fun setStrictRevocation(context: Context, on: Boolean) {
        Prefs(context).matterStrictRevocation = on
        get(context).setMatterStrictRevocation(on)
    }

    /** Adds a Matter device with its pairing code; this can take a minute. */
    suspend fun addMatter(context: Context, code: String): String = withContext(Dispatchers.IO) { get(context).addMatterDevice(code) }

    /**
     * Adds a new Matter device over Bluetooth (ADR 0073): finds it by its
     * advertisement, then the bridge runs the rest over this phone's GATT
     * connection. onStep hears each step; this can take two minutes.
     */
    suspend fun addMatterOverBluetooth(
        context: Context, code: String, ssid: String, password: String, dataset: String, onStep: (BleStep) -> Unit,
    ): String {
        onStep(BleStep.Find)
        val address = MatterGatt.find(context, code)
            ?: throw java.io.IOException("No device in pairing mode answered over Bluetooth. Keep it close to the phone and make sure it's in pairing mode (new devices are, for a while after they're plugged in).")
        return withContext(Dispatchers.IO) {
            get(context).addMatterDeviceOverBluetooth(code, address, ssid, password, dataset, MatterGatt(context.applicationContext),
                object : MatterSteps {
                    override fun onStep(step: String) {
                        BleStep.of(step)?.let(onStep)
                    }
                })
        }
    }
}
