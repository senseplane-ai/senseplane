// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app

import com.senseplane.app.api.Api
import com.senseplane.app.api.ApiException
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
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
}
