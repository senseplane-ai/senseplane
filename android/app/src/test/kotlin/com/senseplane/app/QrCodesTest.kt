// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.senseplane.app.box.QrCodes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QrCodesTest {
    /** A QR code as a camera's Y plane: dark modules on white, rows padded like a real stride. */
    private fun frame(text: String, size: Int = 240, stride: Int = 256): ByteArray {
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
        val y = ByteArray(stride * size) { 0xFF.toByte() }
        for (r in 0 until size) for (c in 0 until size) if (m[c, r]) y[r * stride + c] = 0
        return y
    }

    @Test
    fun readsAMatterQrCode() {
        val text = "MT:-24J0AFN00KA0648G00"
        assertEquals(text, QrCodes.matter(QrCodes.decode(frame(text), 240, 240, 256)))
    }

    @Test
    fun ignoresOtherQrCodesAndBlankFrames() {
        assertNull(QrCodes.matter(QrCodes.decode(frame("https://example.com"), 240, 240, 256)))
        assertEquals("https://example.com", QrCodes.decode(frame("https://example.com"), 240, 240, 256))
        assertNull(QrCodes.decode(ByteArray(256 * 240) { 0x7F }, 240, 240, 256))
        assertNull(QrCodes.matter("MT:"))
        assertEquals("MT:Y.K9042C00KA0648G00", QrCodes.matter(" MT:Y.K9042C00KA0648G00 "))
    }
}
