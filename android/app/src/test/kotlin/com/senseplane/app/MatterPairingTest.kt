// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app

import com.senseplane.app.box.BlePairing
import com.senseplane.app.box.BleStep
import com.senseplane.app.box.MatterPairing
import com.senseplane.app.box.Needs
import com.senseplane.app.box.StepState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MatterPairingTest {
    @Test
    fun permissionsDependOnTheAndroidVersion() {
        assertEquals(listOf("android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"), MatterPairing.permissions(34))
        assertEquals(listOf("android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"), MatterPairing.permissions(31))
        assertEquals(listOf("android.permission.ACCESS_FINE_LOCATION"), MatterPairing.permissions(30))
        assertEquals(listOf("android.permission.ACCESS_FINE_LOCATION"), MatterPairing.permissions(26))
    }

    @Test
    fun startsWithACodeAndANetwork() {
        assertTrue(MatterPairing.looksLikeCode("3497-011-2332"))
        assertTrue(MatterPairing.looksLikeCode("MT:-24J0AFN00KA0648G00"))
        assertTrue(MatterPairing.looksLikeCode("mt:Y.K9042C00KA0648G00"))
        assertFalse(MatterPairing.looksLikeCode("1234"))
        assertFalse(MatterPairing.looksLikeCode("3497-011-233x"))
        assertFalse(MatterPairing.looksLikeCode("MT:"))
        assertTrue(MatterPairing.canStart("34970112332", "Home", ""))
        assertTrue(MatterPairing.canStart("34970112332", "", "0e08"))
        assertFalse(MatterPairing.canStart("34970112332", " ", ""))
        assertFalse(MatterPairing.canStart("1234", "Home", ""))
    }

    @Test
    fun failuresThatAskForANetwork() {
        val wifi = MatterPairing.failure(BleStep.Network, "needs-wifi: this device joins Wi-Fi: enter the Wi-Fi network's name and password")
        assertEquals(Needs.WiFi, wifi.needs)
        assertEquals("this device joins Wi-Fi: enter the Wi-Fi network's name and password", wifi.message)
        val thread = MatterPairing.failure(BleStep.Network, "needs-thread: this is a Thread device: …")
        assertEquals(Needs.Thread, thread.needs)
        val other = MatterPairing.failure(BleStep.Secure, "the code doesn't match the device")
        assertNull(other.needs)
        assertEquals("The code doesn't match the device", other.message)
        assertEquals("Couldn't add it.", MatterPairing.failure(null, null).message)
    }

    @Test
    fun theChecklistFollowsTheSteps() {
        assertTrue(MatterPairing.progress(BlePairing.Idle).all { it.second == StepState.Todo })
        val working = MatterPairing.progress(BlePairing.Working(BleStep.Check)).toMap()
        assertEquals(StepState.Done, working[BleStep.Find])
        assertEquals(StepState.Done, working[BleStep.Secure])
        assertEquals(StepState.Now, working[BleStep.Check])
        assertEquals(StepState.Todo, working[BleStep.Join])
        val failed = MatterPairing.progress(BlePairing.Failed(BleStep.Join, "didn't appear")).toMap()
        assertEquals(StepState.Done, failed[BleStep.Network])
        assertEquals(StepState.Failed, failed[BleStep.Join])
        assertEquals(StepState.Todo, failed[BleStep.Finish])
        assertTrue(MatterPairing.progress(BlePairing.Added(3, null)).all { it.second == StepState.Done })
        // Every step the bridge reports has a place on the list.
        listOf("connecting", "securing", "checking", "network", "joining", "finishing").forEach { assertTrue(it, BleStep.of(it) != null) }
        assertNull(BleStep.of("dancing"))
    }

    @Test
    fun theResultInWords() {
        val clean = MatterPairing.added("""{"node_id":"1","sensors":7,"certified":true,"revocation":"not revoked"}""")
        assertEquals(7, clean.sensors)
        assertNull(clean.note)
        val dev = MatterPairing.added("""{"node_id":"1","sensors":2,"certified":false,"note":"it is a development device","revocation":"not checked: couldn't fetch the CSA's revocation list"}""")
        assertEquals(2, dev.sensors)
        assertEquals("Not certified: it is a development device. Its certificates couldn't be checked for revocation (couldn't fetch the CSA's revocation list).", dev.note)
        assertEquals(0, MatterPairing.added("garbage").sensors)
    }

    @Test
    fun wifiNamesFromAndroid() {
        assertEquals("Home", MatterPairing.ssid("\"Home\""))
        assertEquals("", MatterPairing.ssid("<unknown ssid>"))
        assertEquals("", MatterPairing.ssid(null))
    }
}
