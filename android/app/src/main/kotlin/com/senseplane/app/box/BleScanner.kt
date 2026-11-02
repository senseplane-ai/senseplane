// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid
import android.util.Log

/**
 * Listens for BTHome sensors (Shelly BLU and others broadcasting service data
 * 0xFCD2). Nothing is paired or sent to them; the bridge decodes the payload.
 */
class BleScanner(context: Context, private val onData: (mac: String, name: String, data: ByteArray) -> Unit) {
    private val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private var scanning = false

    private val callback = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(type: Int, r: ScanResult) {
            val data = r.scanRecord?.getServiceData(BTHOME) ?: return
            onData(r.device.address, r.scanRecord?.deviceName ?: "", data)
        }
        override fun onBatchScanResults(results: MutableList<ScanResult>) = results.forEach { onScanResult(0, it) }
        override fun onScanFailed(errorCode: Int) {
            Log.w("SenseplaneBle", "scan failed $errorCode")
            scanning = false
        }
    }

    @SuppressLint("MissingPermission") // the app asks for nearby devices first
    fun start(): Boolean {
        val s = adapter?.bluetoothLeScanner ?: return false
        if (scanning || adapter?.isEnabled != true) return scanning
        val filters = listOf(ScanFilter.Builder().setServiceData(BTHOME, ByteArray(0)).build())
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_POWER).build()
        return runCatching { s.startScan(filters, settings, callback); scanning = true; true }.getOrElse {
            Log.w("SenseplaneBle", "can't scan", it)
            false
        }
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        if (!scanning) return
        runCatching { adapter?.bluetoothLeScanner?.stopScan(callback) }
        scanning = false
    }

    companion object {
        val BTHOME: ParcelUuid = ParcelUuid.fromString("0000fcd2-0000-1000-8000-00805f9b34fb")
    }
}
