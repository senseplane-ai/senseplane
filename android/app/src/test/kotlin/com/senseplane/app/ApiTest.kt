// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app

import com.senseplane.app.api.Api
import com.senseplane.app.api.ApiException
import com.senseplane.app.api.askText
import com.senseplane.app.api.commandText
import com.senseplane.app.api.stateText
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class ApiTest {
    private val server = MockWebServer()

    @Before fun start() = server.start()
    @After fun stop() = server.shutdown()

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    @Test
    fun signsInThenCallsWithTheSession() = runTest {
        server.enqueue(json("""{"session":"sk_sess","expires_at":"2026-12-01T00:00:00Z","account_id":"a"}"""))
        server.enqueue(json("""{"data":[{"id":"evt_1","type":"watch.triggered","summary":"The fridge door was left open.","occurred_at":"2026-11-02T08:00:00Z","source":{"id":"src_1","name":"Kitchen sensors"},"media":{}}],"next_cursor":null}"""))
        val api = Api(server.url("/").toString().trimEnd('/'))
        assertEquals("sk_sess", api.signIn("mum@example.com", "pw").session)
        val login = server.takeRequest()
        assertEquals("/auth/login", login.path)
        assertTrue(login.body.readUtf8().contains("\"email\":\"mum@example.com\""))
        val events = api.events()
        assertEquals("The fridge door was left open.", events.single().summary)
        val req = server.takeRequest()
        assertEquals("/v1/events?limit=50", req.path)
        assertEquals("Bearer sk_sess", req.getHeader("Authorization"))
    }

    @Test
    fun errorsCarryTheApisMessage() = runTest {
        server.enqueue(json("""{"error":{"code":"unauthorized","message":"Wrong email or password."}}""", 401))
        try {
            Api(server.url("/").toString()).signIn("a@b.c", "x")
            fail("signed in")
        } catch (e: ApiException) {
            assertEquals(401, e.status)
            assertEquals("Wrong email or password.", e.message)
        }
    }

    @Test
    fun asksInAConversationAndCreatesWatches() = runTest {
        server.enqueue(json("""{"id":"cnv_1"}"""))
        server.enqueue(json("""{"id":"msg_2","role":"assistant","content":"Twice today [1].","moments":[{"source_name":"Kitchen sensors","at":"2026-11-02T08:00:00Z"}]}"""))
        server.enqueue(json("""{"id":"wat_1","instruction":"Tell me if the garage door is left open","status":"active","sources":["src_1"]}""", 201))
        val api = Api(server.url("/").toString(), "sk")
        val c = api.newConversation()
        val m = api.ask(c.id, "How many times was the fridge opened?", "Europe/Berlin")
        assertEquals("Twice today [1].", m.content)
        assertEquals("Kitchen sensors", m.moments.single().sourceName)
        server.takeRequest()
        val ask = server.takeRequest()
        assertEquals("/v1/conversations/cnv_1/messages", ask.path)
        assertTrue(ask.body.readUtf8().contains("\"time_zone\":\"Europe/Berlin\""))
        assertEquals("wat_1", api.createWatch("Tell me if the garage door is left open", listOf("src_1")).id)
        assertTrue(server.takeRequest().body.readUtf8().contains("\"sources\":[\"src_1\"]"))
    }

    private val light = """{"id":"dev_1","entity_id":"light.hall","name":"Hall light","room":"Hall","bridge_id":"brg_1","source_id":"src_1","type":"light","tier":"switch","controllable":true,"actions":["turn_on","turn_off","set_brightness"],"state":{"available":true,"on":false},"online":true,"can_control":true,"warning":""}"""
    private val door = """{"id":"dev_2","entity_id":"lock.front","name":"Front door","room":null,"bridge_id":"brg_1","source_id":"src_1","type":"lock","tier":"secure","controllable":true,"actions":["lock","unlock"],"state":{"locked":true},"online":true,"can_control":true,"warning":"Locks open doors."}"""
    private fun cmd(status: String, message: String) =
        """{"id":"dcm_1","device_id":"dev_1","device_name":"Hall light","entity_id":"light.hall","action":"turn_on","value":null,"status":"$status","message":"$message","state":{"on":true,"brightness":80},"requested_by":{"kind":"user","id":"usr_1","name":"Mum"},"via":"app","expires_at":null,"decided_by":null,"created_at":"2026-11-03T08:00:00Z","finished_at":null}"""

    @Test
    fun listsDevicesWithTheirState() = runTest {
        server.enqueue(json("""{"data":[$light,$door],"next_cursor":null}"""))
        val devices = Api(server.url("/").toString(), "sk").devices()
        val req = server.takeRequest()
        assertEquals("/v1/devices", req.path)
        assertEquals("app", req.getHeader("X-Senseplane-Via"))
        assertEquals(2, devices.size)
        val (l, d) = devices
        assertEquals("Hall", l.room)
        assertEquals(false, l.state?.on)
        assertTrue(l.canControl && l.online && l.controllable)
        assertEquals(listOf("turn_on", "turn_off", "set_brightness"), l.actions)
        assertEquals("Off", stateText(l))
        assertEquals("secure", d.tier)
        assertNull(d.room)
        assertEquals("Locked", stateText(d))
    }

    @Test
    fun sendsACommandFromTheAppAndReadsTheAnswer() = runTest {
        server.enqueue(json(cmd("done", "Hall light is on.")))
        server.enqueue(json(cmd("unchanged", "Sent, but Hall light still reads off.")))
        val api = Api(server.url("/").toString(), "sk")
        val c = api.command("dev_1", "turn_on")
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/v1/devices/dev_1/commands", req.path)
        assertEquals("app", req.getHeader("X-Senseplane-Via"))
        assertEquals("Bearer sk", req.getHeader("Authorization"))
        assertEquals("""{"action":"turn_on"}""", req.body.readUtf8())
        assertEquals("done", c.status)
        assertEquals("Hall light is on.", commandText(c))
        assertEquals(80.0, c.state?.brightness)
        assertEquals("Mum", c.requestedBy?.name)
        assertEquals("app", c.via)

        val u = api.command("dev_1", "set_brightness", 40)
        assertEquals("""{"action":"set_brightness","value":40}""", server.takeRequest().body.readUtf8())
        assertEquals("unchanged", u.status)
        assertEquals("Sent, but Hall light still reads off.", commandText(u))
    }

    @Test
    fun aSecureDeviceNeedsConfirm() = runTest {
        server.enqueue(json("""{"error":{"code":"confirmation_required","message":"Confirm to unlock Front door.","details":{}}}""", 409))
        server.enqueue(json(cmd("done", "Front door is unlocked.")))
        val api = Api(server.url("/").toString(), "sk")
        try {
            api.command("dev_2", "unlock")
            fail("sent without confirm")
        } catch (e: ApiException) {
            assertEquals(409, e.status)
            assertEquals("confirmation_required", e.code)
            assertEquals("Confirm to unlock Front door.", e.message)
            assertNull(e.command)
        }
        assertFalse(server.takeRequest().body.readUtf8().contains("confirm"))
        assertEquals("done", api.command("dev_2", "unlock", confirm = true).status)
        assertEquals("""{"action":"unlock","confirm":true}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun aFailedCommandCarriesItsCommand() = runTest {
        server.enqueue(json("""{"error":{"code":"device_offline","message":"Hall light's box isn't answering.","details":{"command":${cmd("offline", "Hall light's box isn't answering.")}}}}""", 503))
        server.enqueue(json("""{"error":{"code":"not_controllable","message":"An admin hasn't allowed control of Hall light."}}""", 409))
        val api = Api(server.url("/").toString(), "sk")
        try {
            api.command("dev_1", "turn_on"); fail("sent")
        } catch (e: ApiException) {
            assertEquals("device_offline", e.code)
            assertEquals("offline", e.command?.status)
        }
        try {
            api.command("dev_1", "turn_on"); fail("sent")
        } catch (e: ApiException) {
            assertEquals("not_controllable", e.code)
            assertNull(e.command)
        }
    }

    @Test
    fun listsAndDecidesConfirmations() = runTest {
        val waiting = """{"id":"dcm_2","device_id":"dev_2","device_name":"Front door","entity_id":"lock.front","action":"unlock","value":null,"status":"awaiting_confirmation","message":"Waiting for a person.","state":null,"requested_by":{"kind":"agent","id":"agt_1","name":"Home assistant"},"via":"agent","expires_at":"2026-11-03T08:02:00Z","decided_by":null,"created_at":"2026-11-03T08:00:00Z","finished_at":null}"""
        server.enqueue(json("""{"data":[$waiting]}"""))
        server.enqueue(json(cmd("denied", "Denied by Mum.")))
        val api = Api(server.url("/").toString(), "sk")
        val c = api.confirmations().single()
        assertEquals("/v1/confirmations", server.takeRequest().path)
        assertEquals("awaiting_confirmation", c.status)
        assertEquals("2026-11-03T08:02:00Z", c.expiresAt)
        assertEquals("Home assistant asks to unlock Front door.", askText(c))
        val d = api.decide(c.id, approve = false)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/v1/confirmations/dcm_2", req.path)
        assertEquals("""{"approve":false}""", req.body.readUtf8())
        assertEquals("app", req.getHeader("X-Senseplane-Via"))
        assertEquals("denied", d.status)
    }
}
