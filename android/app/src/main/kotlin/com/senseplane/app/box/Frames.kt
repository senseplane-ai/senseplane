// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

/**
 * Turns MediaCodec's H.264 output into the access units the bridge relays:
 * Annex B, each keyframe led by the stream's SPS and PPS (MediaCodec sends
 * those once, as codec config), with each frame's duration taken from the
 * presentation times.
 */
class Frames(private val fps: Int, private val emit: (ByteArray, Long, Boolean) -> Unit) {
    private var config: ByteArray? = null
    private var lastPtsUs = -1L

    /** The codec config (SPS and PPS) MediaCodec gives before the first frame. */
    fun onConfig(csd: ByteArray) {
        config = csd.copyOf()
    }

    /** One encoded frame; dropped until the config has come and the first keyframe arrives. */
    fun onFrame(data: ByteArray, ptsUs: Long, keyframe: Boolean) {
        val csd = config ?: return
        if (lastPtsUs < 0 && !keyframe) return
        val duration = if (lastPtsUs < 0 || ptsUs <= lastPtsUs) 1_000_000L / fps else ptsUs - lastPtsUs
        lastPtsUs = ptsUs
        val au = if (keyframe && !startsWithSps(data)) csd + data else data
        emit(au, duration, keyframe)
    }

    fun reset() {
        lastPtsUs = -1L
    }

    companion object {
        /** Whether an Annex B buffer begins with an SPS (NAL type 7), as some encoders already do on keyframes. */
        fun startsWithSps(b: ByteArray): Boolean {
            val i = when {
                b.size > 4 && b[0] == 0.toByte() && b[1] == 0.toByte() && b[2] == 0.toByte() && b[3] == 1.toByte() -> 4
                b.size > 3 && b[0] == 0.toByte() && b[1] == 0.toByte() && b[2] == 1.toByte() -> 3
                else -> return false
            }
            return (b[i].toInt() and 0x1F) == 7
        }
    }
}
