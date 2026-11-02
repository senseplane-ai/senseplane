// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app

import com.senseplane.app.box.Frames
import com.senseplane.app.box.LightThrottle
import com.senseplane.app.box.MotionDetector
import com.senseplane.app.box.parseFound
import com.senseplane.app.box.parseSensors
import com.senseplane.app.box.parseStatus
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FramesTest {
    private val sps = byteArrayOf(0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 3)
    private val idr = byteArrayOf(0, 0, 0, 1, 0x65, 9, 9)
    private val p = byteArrayOf(0, 0, 0, 1, 0x41, 7)

    @Test
    fun keyframesCarryTheConfigAndDurationsComeFromTimes() {
        val out = mutableListOf<Triple<ByteArray, Long, Boolean>>()
        val f = Frames(15) { au, d, k -> out += Triple(au, d, k) }
        f.onFrame(idr, 0, true) // before the config: dropped
        f.onConfig(sps)
        f.onFrame(p, 10_000, false) // before a keyframe: dropped
        f.onFrame(idr, 100_000, true)
        f.onFrame(p, 166_666, false)
        f.onFrame(idr, 233_333, true)
        assertEquals(3, out.size)
        assertArrayEquals(sps + idr, out[0].first)
        assertEquals(66_666L, out[0].second) // the first frame: one frame at 15 fps
        assertTrue(out[0].third)
        assertArrayEquals(p, out[1].first)
        assertEquals(66_666L, out[1].second)
        assertEquals(66_667L, out[2].second)
    }

    @Test
    fun aKeyframeThatAlreadyStartsWithItsSpsIsLeftAlone() {
        assertTrue(Frames.startsWithSps(sps))
        assertFalse(Frames.startsWithSps(idr))
        val out = mutableListOf<ByteArray>()
        val f = Frames(15) { au, _, _ -> out += au }
        f.onConfig(sps)
        f.onFrame(sps + idr, 0, true)
        assertArrayEquals(sps + idr, out[0])
    }

    @Test
    fun motionAfterAJoltAndStillAfterThirtySeconds() {
        val seen = mutableListOf<Boolean>()
        val m = MotionDetector { seen += it }
        m.sample(0f, 0f, 9.81f, 0)
        m.sample(6f, 0f, 9.81f, 1_000)
        m.sample(0f, 0f, 9.81f, 20_000)
        m.sample(0f, 0f, 9.81f, 32_000)
        assertEquals(listOf(true, false), seen)
    }

    @Test
    fun lightOnlyWhenItChangesAndNotTooOften() {
        val seen = mutableListOf<Double>()
        val l = LightThrottle { seen += it }
        l.sample(100.0, 0)
        l.sample(105.0, 40_000) // too small a change
        l.sample(300.0, 50_000)
        l.sample(10.0, 60_000) // too soon
        assertEquals(listOf(100.0, 300.0), seen)
    }

    @Test
    fun readsTheBoxStatusFoundCamerasAndSensors() {
        val s = parseStatus("""{"state":"running","cameras":[{"source_id":"src_1","state":"online"}],"sensors":3,"sending":1,"found":2,"phone_camera":"src_1","extra":1}""")
        assertTrue(s.running)
        assertEquals("src_1", s.phoneCamera)
        assertEquals("online", s.cameras.single().state)
        assertEquals("stopped", parseStatus("not json").state)
        val found = parseFound("""[{"id":"urn:uuid:1","address":"192.168.1.52","manufacturer":"TP-Link","model":"Tapo C200","onvif":true}]""")
        assertEquals("TP-Link Tapo C200", found.single().title)
        val sensors = parseSensors("""[{"entity_id":"bthome.aa_contact","name":"Fridge door","sense":"contact","kind":"state","chosen":true},{"entity_id":"phone.battery","name":"Battery","sense":"battery","kind":"number","chosen":false}]""")
        assertEquals("Bluetooth sensors nearby", sensors[0].group)
        assertEquals("This phone", sensors[1].group)
        assertEquals("Matter devices", parseSensors("""[{"entity_id":"matter.n5_e1_power","name":"Plug","sense":"power","kind":"number","chosen":false}]""").single().group)
        assertEquals(2, parseStatus("""{"state":"running","matter":2}""").matter)
    }
}
