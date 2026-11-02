// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app

import android.Manifest
import android.os.Build
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.senseplane.app.box.BoxHolder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The phone as a box, end to end against a running Senseplane (ADR 0064):
 * pair with the code the app shows (approved over the API, as an admin does
 * in the console), choose what the phone does, then see its camera online and
 * recording, and a sensor chosen in the app arrive.
 *
 *   ./gradlew connectedDebugAndroidTest \
 *     -Pandroid.testInstrumentationRunnerArguments.server=http://10.0.2.2:58080 \
 *     -Pandroid.testInstrumentationRunnerArguments.whipBase=http://10.0.2.2:58090 \
 *     -Pandroid.testInstrumentationRunnerArguments.ownerKey=sk_...
 */
@RunWith(AndroidJUnit4::class)
class PhoneBoxE2ETest {
    private val args = InstrumentationRegistry.getArguments()
    private val server = args.getString("server") ?: ""
    private val ownerKey = args.getString("ownerKey") ?: ""

    @get:Rule(order = 0)
    val permissions: GrantPermissionRule = GrantPermissionRule.grant(*buildList {
        add(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        if (Build.VERSION.SDK_INT >= 31) add(Manifest.permission.BLUETOOTH_SCAN)
    }.toTypedArray())

    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    private val http = OkHttpClient()
    private val js = Json { ignoreUnknownKeys = true }

    private fun call(method: String, path: String, body: String? = null): JsonObject {
        val req = Request.Builder().url(server + path).header("Authorization", "Bearer $ownerKey")
            .method(method, body?.toRequestBody("application/json".toMediaType())).build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            check(res.isSuccessful) { "$method $path: ${res.code} $text" }
            return if (text.isBlank()) JsonObject(emptyMap()) else js.parseToJsonElement(text).jsonObject
        }
    }

    private fun <T> eventually(what: String, seconds: Int, f: () -> T?): T {
        val end = System.currentTimeMillis() + seconds * 1000L
        while (System.currentTimeMillis() < end) {
            runCatching(f).getOrNull()?.let { return it }
            Thread.sleep(1000)
        }
        throw AssertionError("timed out waiting for $what")
    }

    @Before
    fun fresh() {
        assumeTrue("needs -e server and -e ownerKey", server.isNotEmpty() && ownerKey.isNotEmpty())
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        ctx.getSharedPreferences("senseplane", 0).edit().clear()
            .putString("whip_base", args.getString("whipBase") ?: "")
            .putString("phone_name", "E2E phone")
            .commit()
        File(ctx.filesDir, "box").deleteRecursively()
    }

    @Test
    fun pairsSendsItsCameraAndAChosenSensor() {
        compose.onNodeWithText("Get started").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasSetTextAction()).performTextClearance()
        compose.onNode(hasSetTextAction()).performTextInput(server)
        compose.waitForIdle()
        compose.onNodeWithText("Continue").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Enter this code in Senseplane")).fetchSemanticsNodes().isNotEmpty() }
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        check(Prefs(ctx).server == server) { "the server kept was '${Prefs(ctx).server}'" }

        // The app shows a code; an admin connects it (the console does this POST).
        val code = try {
            eventually("the pairing code", 45) { BoxHolder.status.value.code }
        } catch (e: AssertionError) {
            throw AssertionError("no code; the box says ${BoxHolder.status.value}", e)
        }
        compose.waitUntil(10_000) { compose.onAllNodes(hasText(code)).fetchSemanticsNodes().isNotEmpty() }
        val box = call("POST", "/v1/bridges/pair", """{"code":"$code","name":"E2E phone"}""")
        val bridgeId = box["id"]!!.jsonPrimitive.content

        // Connected: choose what it does (both), allow, and the phone tab shows.
        compose.waitUntil(60_000) { compose.onAllNodes(hasText("What this phone does")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Continue").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Allow")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Allow").performClick()
        compose.waitUntil(30_000) { compose.onAllNodes(hasText("Running in the background")).fetchSemanticsNodes().isNotEmpty() }

        // Its camera is a camera on its box, online and recording.
        val cam = eventually("the phone's camera online", 120) {
            call("GET", "/v1/sources")["data"]!!.jsonArray.map { it.jsonObject }
                .firstOrNull { it["bridge_id"]?.jsonPrimitive?.content == bridgeId && it["type"]?.jsonPrimitive?.content == "rtsp" && it["status"]?.jsonPrimitive?.content == "online" }
        }
        val camId = cam["id"]!!.jsonPrimitive.content
        eventually("a recording", 60) {
            (call("GET", "/v1/sources/$camId/timeline")["recorded"] as? JsonArray)?.takeIf { it.isNotEmpty() }
        }

        // The phone's battery is listed; chosen in the app, its reading arrives.
        eventually("the phone's sensors listed", 60) {
            call("GET", "/v1/bridges/$bridgeId/entities")["data"]!!.jsonArray.map { it.jsonObject }
                .firstOrNull { it["entity_id"]?.jsonPrimitive?.content == "phone.battery" }
        }
        compose.waitUntil(30_000) { compose.onAllNodes(hasText("nearby", substring = true)).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("nearby", substring = true)).performScrollTo().performClick()
        compose.waitUntil(30_000) { compose.onAllNodes(hasText("Phone battery")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Phone battery").performClick() // the row's switch follows its label
        val chosen = eventually("the battery chosen", 30) {
            call("GET", "/v1/bridges/$bridgeId/entities")["data"]!!.jsonArray.map { it.jsonObject }
                .firstOrNull { it["entity_id"]?.jsonPrimitive?.content == "phone.battery" && it["chosen"]?.jsonPrimitive?.content == "true" }
        }
        val source = chosen["source_id"]!!.jsonPrimitive.content
        val reading = eventually("the battery reading", 60) {
            call("GET", "/v1/sources/$source/now")["readings"]?.jsonArray?.map { it.jsonObject }
                ?.firstOrNull { it["sense"]?.jsonPrimitive?.content == "battery" }
        }
        assertTrue(reading.toString(), reading["unit"]?.jsonPrimitive?.content == "percent")
    }
}
