// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.senseplane.app.MainActivity
import com.senseplane.app.Prefs
import com.senseplane.app.R
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Keeps the phone working as a box with the screen off: the bridge, the
 * camera, the phone's sensors and Bluetooth sensors. Android needs a visible
 * notification for this; it says what the phone is doing.
 */
class BoxService : Service() {
    private var camera: PhoneCamera? = null
    private var sensors: PhoneSensors? = null
    private var ble: BleScanner? = null
    private var multicast: WifiManager.MulticastLock? = null
    private var wake: PowerManager.WakeLock? = null
    private var network: ConnectivityManager.NetworkCallback? = null
    private var thermal: PowerManager.OnThermalStatusChangedListener? = null
    private var metered = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        val prefs = Prefs(this)
        val box = BoxHolder.get(this)
        startForegroundNow(prefs)

        // ONVIF cameras answer a multicast probe; Android drops multicast without this lock.
        multicast = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).createMulticastLock("senseplane-find-cameras").apply {
            setReferenceCounted(false)
            acquire()
        }
        wake = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "senseplane:box").apply {
            setReferenceCounted(false)
            acquire()
        }
        box.start()
        if (prefs.bridge) {
            sensors = PhoneSensors(this) { sense, kind, value, unit, name -> box.phoneReading(sense, kind, value, unit, name) }.also { it.start() }
            if (hasBluetooth()) ble = BleScanner(this) { mac, name, data -> box.bluetooth(mac, name, data) }.also { it.start() }
        }
        if (prefs.camera && granted(Manifest.permission.CAMERA)) {
            watchNetwork(prefs)
            watchHeat()
            if (!pausedForData(prefs)) startCamera(prefs)
        }
    }

    private fun startCamera(prefs: Prefs) {
        if (camera != null) return
        val box = BoxHolder.get(this)
        box.setCamera(true, prefs.phoneName)
        camera = PhoneCamera(this) { au, durationUs, key -> box.pushFrame(au, durationUs, key) }.also { it.start() }
        _paused.value = null
    }

    private fun pauseCamera(reason: String) {
        camera?.close()
        camera = null
        BoxHolder.get(this).setCamera(false, Prefs(this).phoneName)
        _paused.value = reason
    }

    private fun pausedForData(prefs: Prefs) = metered && !prefs.videoOnMobile

    /** Video goes only over Wi-Fi and other unmetered networks unless mobile data is allowed in Settings. */
    private fun watchNetwork(prefs: Prefs) {
        val cm = getSystemService(ConnectivityManager::class.java)
        metered = cm.isActiveNetworkMetered
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(n: Network, caps: NetworkCapabilities) {
                val now = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
                if (now == metered) return
                metered = now
                if (pausedForData(prefs)) pauseCamera("Paused on mobile data") else startCamera(prefs)
            }
        }
        cm.registerDefaultNetworkCallback(cb)
        network = cb
    }

    /** A warm phone sends less (see PhoneCamera.setWarm). */
    private fun watchHeat() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val pm = getSystemService(PowerManager::class.java)
        val l = PowerManager.OnThermalStatusChangedListener { status -> camera?.setWarm(status >= PowerManager.THERMAL_STATUS_MODERATE) }
        pm.addThermalStatusListener(mainExecutor, l)
        thermal = l
    }

    /** The screen shows the camera here (null: it went away). */
    fun setPreview(surface: android.view.Surface?) {
        camera?.setPreview(surface)
    }

    private fun startForegroundNow(prefs: Prefs) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Senseplane running", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val what = listOfNotNull(
            "camera".takeIf { prefs.camera && granted(Manifest.permission.CAMERA) },
            "IP cameras and sensors".takeIf { prefs.bridge },
        ).joinToString(" and ").ifEmpty { "connected" }
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_eye)
            .setContentTitle("Senseplane is running")
            .setContentText("Sending this phone's $what")
            .setOngoing(true)
            .setContentIntent(open)
            .build()
        var types = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            types = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            if (prefs.camera && granted(Manifest.permission.CAMERA) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        ServiceCompat.startForeground(this, NOTIFICATION, n, types)
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun hasBluetooth() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) granted(Manifest.permission.BLUETOOTH_SCAN) else granted(Manifest.permission.ACCESS_FINE_LOCATION)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        instance = null
        camera?.close()
        BoxHolder.get(this).setCamera(false, Prefs(this).phoneName)
        network?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) thermal?.let { getSystemService(PowerManager::class.java).removeThermalStatusListener(it) }
        _paused.value = null
        sensors?.stop()
        ble?.stop()
        BoxHolder.get(this).stop()
        runCatching { multicast?.release() }
        runCatching { wake?.release() }
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "box"
        private const val NOTIFICATION = 1
        @Volatile var instance: BoxService? = null
            private set
        private val _paused = MutableStateFlow<String?>(null)
        /** Why the camera isn't sending right now (null: it is, or it's off). */
        val paused: StateFlow<String?> = _paused
    }
}
