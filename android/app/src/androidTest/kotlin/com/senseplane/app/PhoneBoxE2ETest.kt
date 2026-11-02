// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app

import android.Manifest
import android.os.Build
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onFirst
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
import org.junit.Rule
import org.junit.rules.ExternalResource
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
 *     -Pandroid.testInstrumentationRunnerArguments.ownerKey=sk_... \
 *     -Pandroid.testInstrumentationRunnerArguments.matterAddress=10.0.2.2:5540   # optional: go run ./cmd/matter-fake-device
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

    // A fresh phone, before the activity starts.
    @get:Rule(order = 1)
    val fresh = object : ExternalResource() {
        override fun before() {
            assumeTrue("needs -e server and -e ownerKey", server.isNotEmpty() && ownerKey.isNotEmpty())
            val ctx = InstrumentationRegistry.getInstrumentation().targetContext
            ctx.getSharedPreferences("senseplane", 0).edit().clear()
                .putString("whip_base", args.getString("whipBase") ?: "")
                .putString("matter_address", args.getString("matterAddress") ?: "")
                .putString("phone_name", "E2E phone")
                .commit()
            File(ctx.filesDir, "box").deleteRecursively()
            File(ctx.getExternalFilesDir(null), "shots").deleteRecursively()
        }
    }

    @get:Rule(order = 2)
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

    /** A screenshot for people reviewing the app (adb pull /sdcard/Android/data/com.senseplane.app/files/shots). */
    private fun shot(name: String) {
        compose.waitForIdle()
        Thread.sleep(1000) // the screen transition finishes
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "shots").apply { mkdirs() }
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bmp ->
            File(dir, "$name.png").outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
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

    @Test
    fun pairsSendsItsCameraAndAChosenSensor() {
        shot("01-welcome")
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
        shot("02-pair-code")
        val box = call("POST", "/v1/bridges/pair", """{"code":"$code","name":"E2E phone"}""")
        val bridgeId = box["id"]!!.jsonPrimitive.content

        // Connected: choose what it does (both), allow, and the phone tab shows.
        compose.waitUntil(60_000) { compose.onAllNodes(hasText("What this phone does")).fetchSemanticsNodes().isNotEmpty() }
        shot("03-mode")
        compose.onNodeWithText("Continue").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Allow")).fetchSemanticsNodes().isNotEmpty() }
        shot("04-permissions")
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
        shot("07-sensors")
        val source = chosen["source_id"]!!.jsonPrimitive.content
        val reading = eventually("the battery reading", 60) {
            call("GET", "/v1/sources/$source/now")["readings"]?.jsonArray?.map { it.jsonObject }
                ?.firstOrNull { it["sense"]?.jsonPrimitive?.content == "battery" }
        }
        assertTrue(reading.toString(), reading["unit"]?.jsonPrimitive?.content == "percent")

        // A Matter plug (bridge/cmd/matter-fake-device on the computer) added with its code in the app.
        if (args.getString("matterAddress").orEmpty().isNotEmpty()) {
            compose.onNodeWithText("Add a Matter device").performScrollTo().performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("Get a code")).fetchSemanticsNodes().isNotEmpty() }
            compose.onNode(hasSetTextAction()).performTextInput("3497-011-2332")
            shot("15-matter")
            compose.onNodeWithText("Add device").performClick()
            compose.waitUntil(120_000) { compose.onAllNodes(hasText("Fake plug")).fetchSemanticsNodes().isNotEmpty() }
            shot("16-matter-sensors")
            val power = eventually("the plug's sensors listed", 60) {
                call("GET", "/v1/bridges/$bridgeId/entities")["data"]!!.jsonArray.map { it.jsonObject }
                    .firstOrNull { it["entity_id"]!!.jsonPrimitive.content.startsWith("matter.") && it["sense"]?.jsonPrimitive?.content == "power" }
            }
            val powerId = power["entity_id"]!!.jsonPrimitive.content
            val chosenPower = call("PATCH", "/v1/bridges/$bridgeId/entities", """{"choose":["$powerId"]}""")["data"]!!.jsonArray.map { it.jsonObject }
                .first { it["entity_id"]!!.jsonPrimitive.content == powerId }
            val plugSource = chosenPower["source_id"]!!.jsonPrimitive.content
            val watts = eventually("the plug's power reading", 90) {
                call("GET", "/v1/sources/$plugSource/now")["readings"]?.jsonArray?.map { it.jsonObject }
                    ?.firstOrNull { it["sense"]?.jsonPrimitive?.content == "power" }
            }
            assertTrue(watts.toString(), watts["unit"]?.jsonPrimitive?.content == "watt")
        }

        // The rest of the screens, for review.
        back()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Running in the background")).fetchSemanticsNodes().isNotEmpty() }
        shot("05-phone-tab")
        compose.onNodeWithText("Camera").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Dim the screen")).fetchSemanticsNodes().isNotEmpty() }
        Thread.sleep(2000) // the preview starts
        shot("06-camera")
        back()
        compose.onNode(hasText("Add an IP camera", substring = true)).performScrollTo().performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Found on this Wi-Fi", substring = true, ignoreCase = true)).fetchSemanticsNodes().isNotEmpty() }
        shot("08-add-camera")
        back()
        compose.onNodeWithText("Settings").performClick()
        shot("09-settings")
        // Signed in as an admin (the test account's key stands in for a session).
        Prefs(InstrumentationRegistry.getInstrumentation().targetContext).session = ownerKey
        back()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("and manage", substring = true)).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("and manage", substring = true)).performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Ask")).fetchSemanticsNodes().isNotEmpty() }
        shot("10-chat")
        for ((tab, name) in listOf("Activity" to "11-activity", "Cameras" to "12-cameras", "Watches" to "13-watches", "More" to "14-more")) {
            compose.onAllNodes(hasText(tab)).onFirst().performClick()
            compose.waitUntil(15_000) { compose.onAllNodes(hasText("Loading…")).fetchSemanticsNodes().isEmpty() }
            shot(name)
        }
    }

    private fun back() = compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
}
