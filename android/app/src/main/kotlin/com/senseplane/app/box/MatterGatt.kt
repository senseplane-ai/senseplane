// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Log
import com.senseplane.go.mobile.BLEInbox
import com.senseplane.go.mobile.MatterBLE
import com.senseplane.go.mobile.Mobile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The phone's Bluetooth connection to a Matter device being added (ADR
 * 0073): only the GATT reads and writes. BTP, PASE and the rest run in the
 * bridge, which calls connect, write and close from its own thread.
 */
@SuppressLint("MissingPermission") // the screen asks for nearby devices first
class MatterGatt(private val context: Context) : MatterBLE {
    private var gatt: BluetoothGatt? = null
    private var c1: BluetoothGattCharacteristic? = null
    private var c2: BluetoothGattCharacteristic? = null
    @Volatile private var inbox: BLEInbox? = null
    @Volatile private var mtu = 23
    private var subscribed = false
    /** What each GATT step answered: the callbacks put, the bridge's thread takes. */
    private val events = LinkedBlockingQueue<Event>()

    private sealed interface Event {
        data class Connected(val up: Boolean, val status: Int) : Event
        data class Mtu(val mtu: Int) : Event
        data class Services(val status: Int) : Event
        data class Written(val status: Int) : Event
        data class Subscribed(val status: Int) : Event
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            val up = newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS
            if (!up) inbox?.disconnected("Bluetooth disconnected (status $status)")
            events.offer(Event.Connected(up, status))
        }
        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            events.offer(Event.Mtu(if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23))
        }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) { events.offer(Event.Services(status)) }
        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) { events.offer(Event.Written(status)) }
        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) { events.offer(Event.Subscribed(status)) }
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            if (c.uuid == C2) inbox?.indicated(value)
        }
        @Deprecated("Android 12 and older")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            if (Build.VERSION.SDK_INT < 33 && c.uuid == C2) inbox?.indicated(c.value ?: return)
        }
    }

    private inline fun <reified T : Event> await(what: String, seconds: Long = 15): T {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
        while (true) {
            val left = deadline - System.nanoTime()
            val e = events.poll(left.coerceAtLeast(0), TimeUnit.NANOSECONDS) ?: throw IOException("the device didn't answer ($what)")
            if (e is Event.Connected && !e.up) throw IOException("the device disconnected ($what, status ${e.status})")
            if (e is T) return e
        }
    }

    override fun connect(address: String, inbox: BLEInbox): Long {
        this.inbox = inbox
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter ?: throw IOException("this phone has no Bluetooth")
        if (!adapter.isEnabled) throw IOException("Bluetooth is off; turn it on")
        val device = adapter.getRemoteDevice(address)
        events.clear()
        val g = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE) ?: throw IOException("couldn't connect")
        gatt = g
        await<Event.Connected>("connecting", 20)
        // A larger MTU means fewer BTP segments; the device may not take it.
        if (g.requestMtu(247)) mtu = runCatching { await<Event.Mtu>("the MTU", 5).mtu }.getOrDefault(23)
        if (!g.discoverServices()) throw IOException("couldn't look for the device's Matter service")
        val s = await<Event.Services>("finding its services")
        if (s.status != BluetoothGatt.GATT_SUCCESS) throw IOException("couldn't read the device's services (status ${s.status})")
        val service = g.getService(SERVICE) ?: throw IOException("the device has no Matter Bluetooth service")
        c1 = service.getCharacteristic(C1) ?: throw IOException("the device's Matter service has no C1")
        c2 = service.getCharacteristic(C2) ?: throw IOException("the device's Matter service has no C2")
        return mtu.toLong()
    }

    override fun write(data: ByteArray) {
        val g = gatt ?: throw IOException("not connected")
        val c = c1 ?: throw IOException("not connected")
        val started = if (Build.VERSION.SDK_INT >= 33) {
            g.writeCharacteristic(c, data, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            c.value = data
            c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            @Suppress("DEPRECATION")
            g.writeCharacteristic(c)
        }
        if (!started) throw IOException("couldn't write to the device")
        val w = await<Event.Written>("a write")
        if (w.status != BluetoothGatt.GATT_SUCCESS) throw IOException("the device refused a write (status ${w.status})")
        if (!subscribed) subscribe(g)
    }

    /** After the handshake request: indications on C2, where the handshake response comes. */
    private fun subscribe(g: BluetoothGatt) {
        val c = c2 ?: throw IOException("not connected")
        if (!g.setCharacteristicNotification(c, true)) throw IOException("couldn't subscribe to the device")
        val d = c.getDescriptor(CCCD) ?: throw IOException("the device's C2 can't be subscribed to")
        val started = if (Build.VERSION.SDK_INT >= 33) {
            g.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_INDICATION_VALUE) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            d.value = BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
            @Suppress("DEPRECATION")
            g.writeDescriptor(d)
        }
        if (!started) throw IOException("couldn't subscribe to the device")
        val r = await<Event.Subscribed>("subscribing")
        if (r.status != BluetoothGatt.GATT_SUCCESS) throw IOException("the device refused the subscription (status ${r.status})")
        subscribed = true
    }

    override fun close() {
        runCatching { gatt?.disconnect(); gatt?.close() }
        gatt = null
        inbox?.disconnected("closed")
    }

    companion object {
        val SERVICE: UUID = UUID.fromString("0000fff6-0000-1000-8000-00805f9b34fb")
        val C1: UUID = UUID.fromString("18ee2ef5-263d-4559-959f-4f9c429f9d11")
        val C2: UUID = UUID.fromString("18ee2ef5-263d-4559-959f-4f9c429f9d12")
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        /**
         * Scans for the Matter device advertising for this pairing code and
         * returns its Bluetooth address, or null when none was found in time.
         */
        @SuppressLint("MissingPermission")
        suspend fun find(context: Context, code: String, timeoutMs: Long = 30_000): String? {
            val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter ?: throw IOException("this phone has no Bluetooth")
            if (!adapter.isEnabled) throw IOException("Bluetooth is off; turn it on")
            val scanner = adapter.bluetoothLeScanner ?: throw IOException("Bluetooth is off; turn it on")
            val found = CompletableDeferred<String>()
            val cb = object : ScanCallback() {
                override fun onScanResult(type: Int, r: ScanResult) {
                    val data = r.scanRecord?.getServiceData(ParcelUuid(SERVICE)) ?: return
                    if (Mobile.matterAdvertMatches(code, data)) found.complete(r.device.address)
                }
                override fun onBatchScanResults(results: MutableList<ScanResult>) = results.forEach { onScanResult(0, it) }
                override fun onScanFailed(errorCode: Int) {
                    Log.w("SenseplaneMatter", "scan failed $errorCode")
                    found.completeExceptionally(IOException("Bluetooth scanning failed (error $errorCode)"))
                }
            }
            val filters = listOf(ScanFilter.Builder().setServiceData(ParcelUuid(SERVICE), ByteArray(0)).build())
            val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
            scanner.startScan(filters, settings, cb)
            return try {
                withTimeoutOrNull(timeoutMs) { found.await() }
            } finally {
                runCatching { scanner.stopScan(cb) }
            }
        }
    }
}
