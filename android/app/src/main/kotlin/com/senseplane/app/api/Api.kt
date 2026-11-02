// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** An error from the API, with its message for people. */
class ApiException(val status: Int, val code: String, override val message: String) : Exception(message)

@Serializable
data class Session(val session: String, @SerialName("expires_at") val expiresAt: String? = null)

@Serializable
data class Source(
    val id: String,
    val name: String,
    val type: String,
    val status: String = "pending",
    val location: String? = null,
    val senses: List<String> = emptyList(),
)

@Serializable
data class Event(
    val id: String,
    val type: String,
    val summary: String = "",
    @SerialName("occurred_at") val occurredAt: String,
    val source: EventSource? = null,
    val media: Media? = null,
    val verified: Boolean? = null,
)

@Serializable
data class EventSource(val id: String, val name: String? = null)

@Serializable
data class Media(@SerialName("snapshot_url") val snapshotUrl: String? = null, @SerialName("clip_url") val clipUrl: String? = null)

@Serializable
data class Watch(val id: String, val instruction: String, val status: String = "active", val sources: List<String> = emptyList())

@Serializable
data class Conversation(val id: String, val title: String? = null)

@Serializable
data class Moment(@SerialName("source_name") val sourceName: String? = null, val at: String? = null, val label: String? = null)

@Serializable
data class Message(val id: String, val role: String, val content: String, val moments: List<Moment> = emptyList())

@Serializable
private data class Page<T>(val data: List<T>)

/**
 * The Senseplane API for someone who signed in to manage (an owner or admin):
 * cameras, events, chat and watches. `server` is the base address
 * (https://senseplane.example.com); the API is under /v1, sign-in under /auth.
 */
class Api(server: String, var session: String = "", private val http: OkHttpClient = defaultClient) {
    private val base = server.trimEnd('/')
    private val js = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private suspend fun call(method: String, path: String, body: JsonObject? = null): String = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(base + path)
            .method(method, body?.toString()?.toRequestBody("application/json".toMediaType()))
            .apply { if (session.isNotEmpty()) header("Authorization", "Bearer $session") }
            .build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                val err = runCatching { js.parseToJsonElement(text).jsonObject["error"]?.jsonObject }.getOrNull()
                throw ApiException(res.code, err?.get("code")?.jsonPrimitive?.content ?: "error", err?.get("message")?.jsonPrimitive?.content ?: "Senseplane answered ${res.code}.")
            }
            text
        }
    }

    suspend fun signIn(email: String, password: String): Session {
        val s = js.decodeFromString<Session>(call("POST", "/auth/login", buildJsonObject { put("email", email.trim()); put("password", password) }))
        session = s.session
        return s
    }

    suspend fun signOut() {
        runCatching { call("POST", "/auth/logout") }
        session = ""
    }

    suspend fun sources(): List<Source> = js.decodeFromString<Page<Source>>(call("GET", "/v1/sources")).data

    suspend fun events(limit: Int = 50): List<Event> = js.decodeFromString<Page<Event>>(call("GET", "/v1/events?limit=$limit")).data

    suspend fun event(id: String): Event = js.decodeFromString(call("GET", "/v1/events/$id"))

    suspend fun watches(): List<Watch> = js.decodeFromString<Page<Watch>>(call("GET", "/v1/watches")).data

    suspend fun createWatch(instruction: String, sources: List<String>): Watch = js.decodeFromString(call("POST", "/v1/watches", buildJsonObject {
        put("instruction", instruction)
        putJsonArray("sources") { sources.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
    }))

    suspend fun newConversation(): Conversation = js.decodeFromString(call("POST", "/v1/conversations", buildJsonObject {}))

    /** Asks and waits for the whole answer (the console streams it; the app shows it when done). */
    suspend fun ask(conversation: String, question: String, timeZone: String): Message =
        js.decodeFromString(call("POST", "/v1/conversations/$conversation/messages", buildJsonObject { put("content", question); put("time_zone", timeZone) }))

    companion object {
        val defaultClient: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS) // a chat answer can take a while
            .build()
    }
}
