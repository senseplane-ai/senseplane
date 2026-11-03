// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app

import android.content.Context
import android.content.SharedPreferences

/** What the app remembers: the server, what this phone does, and an admin's session (if one signed in). */
class Prefs(context: Context) {
    private val p: SharedPreferences = context.getSharedPreferences("senseplane", Context.MODE_PRIVATE)

    var server: String
        get() = p.getString("server", "") ?: ""
        set(v) = p.edit().putString("server", v.trim().trimEnd('/')).apply()

    /** Send this phone's camera. */
    var camera: Boolean
        get() = p.getBoolean("camera", true)
        set(v) = p.edit().putBoolean("camera", v).apply()

    /** Relay IP cameras and send sensors (Android only). */
    var bridge: Boolean
        get() = p.getBoolean("bridge", true)
        set(v) = p.edit().putBoolean("bridge", v).apply()

    var phoneName: String
        get() = p.getString("phone_name", null) ?: android.os.Build.MODEL ?: "Phone"
        set(v) = p.edit().putString("phone_name", v.trim()).apply()

    /** Dim the screen while the camera runs. */
    var dim: Boolean
        get() = p.getBoolean("dim", true)
        set(v) = p.edit().putBoolean("dim", v).apply()

    var onboarded: Boolean
        get() = p.getBoolean("onboarded", false)
        set(v) = p.edit().putBoolean("onboarded", v).apply()

    /** An admin's session key, only after signing in to manage. */
    var session: String
        get() = p.getString("session", "") ?: ""
        set(v) = p.edit().putString("session", v).apply()

    /** Sends the camera's video over mobile data too (off: only on Wi-Fi and other unmetered networks). */
    var videoOnMobile: Boolean
        get() = p.getBoolean("video_on_mobile", false)
        set(v) = p.edit().putBoolean("video_on_mobile", v).apply()

    /** Refuse Matter devices whose certificates couldn't be checked for revocation (ADR 0073). */
    var matterStrictRevocation: Boolean
        get() = p.getBoolean("matter_strict_revocation", false)
        set(v) = p.edit().putBoolean("matter_strict_revocation", v).apply()

    /** Development only: find every Matter device at this host:port (see Box.setMatterAddress). */
    var matterAddress: String
        get() = p.getString("matter_address", "") ?: ""
        set(v) = p.edit().putString("matter_address", v.trim()).apply()

    /** Development only: where the emulator reaches the media plane (see Box.setWHIPBase). */
    var whipBase: String
        get() = p.getString("whip_base", "") ?: ""
        set(v) = p.edit().putString("whip_base", v.trim()).apply()
}
