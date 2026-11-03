// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.senseplane.go.mobile.Speaker
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Plays 16-bit little-endian mono PCM and returns when it has been heard. */
fun interface AudioOut {
    fun play(pcm: ByteArray, rate: Int)
}

/**
 * The phone as its camera's speaker (talk-back, ADR 0069). The box hands it
 * an agent's or a watch's message, chime included; it plays one at a time
 * and says so on screen while it plays, so people near the phone know.
 */
class PhoneSpeaker(private val out: AudioOut = TrackOut) : Speaker {
    override fun play(pcm: ByteArray?, rate: Long) {
        if (pcm == null || pcm.isEmpty()) return
        require(rate in 8_000..48_000) { "unsupported sample rate $rate" }
        synchronized(this) {
            _speaking.value = true
            try {
                out.play(pcm, rate.toInt())
            } finally {
                _speaking.value = false
            }
        }
    }

    companion object {
        private val _speaking = MutableStateFlow(false)

        /** True while a message plays on this phone. */
        val speaking: StateFlow<Boolean> = _speaking

        /** What the camera screen says while a message plays. */
        const val NOTICE = "An automated message is playing on this phone"

        /** How long 16-bit mono PCM plays, in milliseconds. */
        fun durationMs(bytes: Int, rate: Int): Long = if (rate <= 0) 0 else bytes / 2 * 1000L / rate
    }
}

/** Android's AudioTrack, as speech through the loudspeaker. */
object TrackOut : AudioOut {
    override fun play(pcm: ByteArray, rate: Int) {
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(pcm.size)
            .build()
        try {
            track.write(pcm, 0, pcm.size)
            track.play()
            Thread.sleep(PhoneSpeaker.durationMs(pcm.size, rate) + 150)
        } finally {
            track.stop()
            track.release()
        }
    }
}
