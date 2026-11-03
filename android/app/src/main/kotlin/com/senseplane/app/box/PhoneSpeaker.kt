// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
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
 * and says so on screen while it plays, so people near the phone know. With
 * the phone's volume off it still plays, and says "muted" so the person who
 * sent it isn't told it was heard.
 */
class PhoneSpeaker(
    private val out: AudioOut = TrackOut,
    /** The media volume now (0: muted). */
    private val volume: () -> Int = { 1 },
) : Speaker {
    override fun play(pcm: ByteArray?, rate: Long): String {
        if (pcm == null || pcm.isEmpty()) return ""
        require(rate in 8_000..48_000) { "unsupported sample rate $rate" }
        synchronized(this) {
            val muted = volume() <= 0
            _speaking.value = true
            try {
                out.play(pcm, rate.toInt())
            } finally {
                _speaking.value = false
            }
            return if (muted) MUTED else ""
        }
    }

    companion object {
        private val _speaking = MutableStateFlow(false)

        /** True while a message plays on this phone. */
        val speaking: StateFlow<Boolean> = _speaking

        /** What the camera screen says while a message plays. */
        const val NOTICE = "An automated message is playing on this phone"

        /** What the box is told when the phone's volume was off. */
        const val MUTED = "muted"

        /** How long 16-bit mono PCM plays, in milliseconds. */
        fun durationMs(bytes: Int, rate: Int): Long = if (rate <= 0) 0 else bytes / 2 * 1000L / rate

        /** The phone's media volume, for [PhoneSpeaker]'s `volume`. */
        fun mediaVolume(context: Context): () -> Int {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            return { am.getStreamVolume(AudioManager.STREAM_MUSIC) }
        }
    }
}

/**
 * Android's AudioTrack, as speech through the loudspeaker, streamed in small
 * pieces (no buffer the size of the whole message), and waiting until the last
 * frame has been played.
 */
object TrackOut : AudioOut {
    override fun play(pcm: ByteArray, rate: Int) {
        val min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val buffer = maxOf(min, rate / 5 * 2) // at least 200 ms
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(buffer)
            .build()
        try {
            track.play()
            for (chunk in chunks(pcm.size, buffer / 2)) {
                var off = chunk.first
                while (off < chunk.last + 1) {
                    val n = track.write(pcm, off, chunk.last + 1 - off) // blocks while the buffer is full
                    if (n < 0) throw IllegalStateException("the speaker refused the audio ($n)")
                    off += n
                }
            }
            // Until the last frame is out, or a little past how long it should take.
            val frames = pcm.size / 2
            val deadline = System.currentTimeMillis() + PhoneSpeaker.durationMs(pcm.size, rate) + 2_000
            while (track.playbackHeadPosition < frames && System.currentTimeMillis() < deadline) Thread.sleep(20)
        } finally {
            track.stop()
            track.release()
        }
    }

    /** Byte ranges of at most `size` bytes, on whole 16-bit samples. */
    fun chunks(total: Int, size: Int): List<IntRange> {
        val step = maxOf(2, size - size % 2)
        return (0 until total step step).map { it until minOf(it + step, total) }
    }
}
