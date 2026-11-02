// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.BatteryManager
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * The phone's own sensors, as readings: its battery and whether it is
 * charging (an unplugged phone stops soon), whether it was moved, and the
 * light level. Only changes are reported; the bridge sends the chosen ones.
 */
class PhoneSensors(private val context: Context, private val report: (sense: String, kind: String, value: Double, unit: String, name: String) -> Unit) {
    private val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private var lastBattery = -1
    private var lastCharging: Boolean? = null
    private val motion = MotionDetector { moving -> report("motion", "state", if (moving) 1.0 else 0.0, "", "Phone moved") }
    private val light = LightThrottle { lux -> report("illuminance", "number", lux, "lux", "Light level") }

    private val battery = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            val plugged = i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
            if (level >= 0) {
                val pct = level * 100 / scale.coerceAtLeast(1)
                if (pct != lastBattery) {
                    lastBattery = pct
                    report("battery", "number", pct.toDouble(), "percent", "Phone battery")
                }
            }
            if (plugged != lastCharging) {
                lastCharging = plugged
                report("charging", "state", if (plugged) 1.0 else 0.0, "", "Phone charging")
            }
        }
    }

    private val listener = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            when (e.sensor.type) {
                Sensor.TYPE_ACCELEROMETER -> motion.sample(e.values[0], e.values[1], e.values[2], System.currentTimeMillis())
                Sensor.TYPE_LIGHT -> light.sample(e.values[0].toDouble(), System.currentTimeMillis())
            }
        }
        override fun onAccuracyChanged(s: Sensor?, a: Int) = Unit
    }

    fun start() {
        context.registerReceiver(battery, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let { sm.registerListener(listener, it, SensorManager.SENSOR_DELAY_NORMAL) }
        sm.getDefaultSensor(Sensor.TYPE_LIGHT)?.let { sm.registerListener(listener, it, SensorManager.SENSOR_DELAY_NORMAL) }
    }

    fun stop() {
        runCatching { context.unregisterReceiver(battery) }
        sm.unregisterListener(listener)
    }
}

/** Moved: the acceleration strays from gravity; still again after 30 s without that. */
class MotionDetector(private val threshold: Float = 1.5f, private val calmMs: Long = 30_000, private val onChange: (Boolean) -> Unit) {
    private var moving = false
    private var lastMove = 0L

    fun sample(x: Float, y: Float, z: Float, now: Long) {
        val g = sqrt(x * x + y * y + z * z)
        if (abs(g - SensorManager.GRAVITY_EARTH) > threshold) {
            lastMove = now
            if (!moving) {
                moving = true
                onChange(true)
            }
        } else if (moving && now - lastMove > calmMs) {
            moving = false
            onChange(false)
        }
    }
}

/** Light level: reported when it changes by a fifth or more, at most every 30 s. */
class LightThrottle(private val everyMs: Long = 30_000, private val onReport: (Double) -> Unit) {
    private var last = -1.0
    private var lastAt = Long.MIN_VALUE / 2

    fun sample(lux: Double, now: Long) {
        val changed = last < 0 || abs(lux - last) > maxOf(last * 0.2, 5.0)
        if (changed && now - lastAt >= everyMs) {
            last = lux
            lastAt = now
            onReport(Math.round(lux * 10) / 10.0)
        }
    }
}
