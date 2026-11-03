// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app

import com.senseplane.app.box.MatterPairing
import com.senseplane.app.box.PhoneCamera
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The QR scanner and the phone's own camera stream share one camera. */
class CameraSharingTest {
    @Test
    fun noScannerWhileThePhoneSendsItsVideo() {
        assertFalse(MatterPairing.canScanQr(beACamera = true, boxRunning = true))
        assertTrue(MatterPairing.canScanQr(beACamera = true, boxRunning = false))
        assertTrue(MatterPairing.canScanQr(beACamera = false, boxRunning = true))
    }

    @Test
    fun theCameraIsTriedAgainSoonThenLessOften() {
        val b = PhoneCamera.ReopenBackoff()
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), List(7) { b.next() })
        b.reset()
        assertEquals(1_000L, b.next())
    }
}
