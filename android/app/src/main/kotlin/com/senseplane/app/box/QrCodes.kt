// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/** Reading a Matter QR code ("MT:…") from camera frames, with ZXing. */
object QrCodes {
    private val hints = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        DecodeHintType.TRY_HARDER to true,
    )

    /** The text of a QR code in a frame's luminance (its Y plane), or null. */
    fun decode(luminance: ByteArray, width: Int, height: Int, rowStride: Int = width): String? = try {
        val source = PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)
        QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), hints).text
    } catch (_: ReaderException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }

    /** A Matter onboarding payload from a QR code's text; other QR codes are ignored. */
    fun matter(text: String?): String? = text?.trim()?.takeIf { it.uppercase().startsWith("MT:") && it.length > 3 }
}
