// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app

import com.senseplane.app.box.AudioOut
import com.senseplane.app.box.PhoneSpeaker
import com.senseplane.app.box.TrackOut
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Talk-back (ADR 0069): the phone plays its camera's messages and says so while they play. */
class SpeakerTest {
    @Test
    fun playsAMessageAndSaysSoWhileItPlays() {
        val heard = mutableListOf<Pair<ByteArray, Int>>()
        var shownWhilePlaying = false
        val speaker = PhoneSpeaker(AudioOut { pcm, rate ->
            shownWhilePlaying = PhoneSpeaker.speaking.value
            heard += pcm to rate
        })
        assertFalse(PhoneSpeaker.speaking.value)
        val pcm = byteArrayOf(1, 0, -2, -1)
        assertEquals("", speaker.play(pcm, 24_000))
        assertEquals(1, heard.size)
        assertArrayEquals(pcm, heard[0].first)
        assertEquals(24_000, heard[0].second)
        assertTrue("the screen says a message is playing", shownWhilePlaying)
        assertFalse(PhoneSpeaker.speaking.value)
        assertEquals("An automated message is playing on this phone", PhoneSpeaker.NOTICE)
    }

    @Test
    fun saysWhenThePhonesVolumeIsOff() {
        var played = 0
        val speaker = PhoneSpeaker(AudioOut { _, _ -> played++ }, volume = { 0 })
        assertEquals(PhoneSpeaker.MUTED, speaker.play(byteArrayOf(0, 0), 16_000))
        assertEquals("it still plays", 1, played)
    }

    @Test
    fun stopsSayingSoWhenPlayingFails() {
        val speaker = PhoneSpeaker(AudioOut { _, _ -> throw IllegalStateException("no audio") })
        runCatching { speaker.play(byteArrayOf(0, 0), 16_000) }
        assertFalse(PhoneSpeaker.speaking.value)
        assertTrue(runCatching { speaker.play(byteArrayOf(0, 0), 96_000) }.isFailure)
        assertEquals("", speaker.play(null, 16_000)) // nothing to play
    }

    @Test
    fun streamsInSmallPiecesOnWholeSamples() {
        val parts = TrackOut.chunks(10_001, 4_801)
        assertEquals(0, parts.first().first)
        assertEquals(10_000, parts.last().last)
        assertTrue(parts.all { (it.last - it.first + 1) <= 4_800 && it.first % 2 == 0 })
        assertEquals(10_001, parts.sumOf { it.last - it.first + 1 })
    }

    @Test
    fun knowsHowLongAMessageIs() {
        assertEquals(1000, PhoneSpeaker.durationMs(48_000, 24_000))
        assertEquals(0, PhoneSpeaker.durationMs(100, 0))
    }
}
