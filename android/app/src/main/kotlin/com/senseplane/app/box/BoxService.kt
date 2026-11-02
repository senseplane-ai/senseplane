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
        if (prefs.camera && granted(Manifest.permission.CAMERA)) startCamera(prefs)
    }

    private fun startCamera(prefs: Prefs) {
        val box = BoxHolder.get(this)
        box.setCamera(true, prefs.phoneName)
        camera = PhoneCamera(this) { au, durationUs, key -> box.pushFrame(au, durationUs, key) }.also { it.start() }
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
    }
}
