// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.remember
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.senseplane.app.box.BoxHolder
import com.senseplane.app.ui.AddCameraScreen
import com.senseplane.app.ui.CameraDetailScreen
import com.senseplane.app.ui.CameraScreen
import com.senseplane.app.ui.EventScreen
import com.senseplane.app.ui.HomeScreen
import com.senseplane.app.ui.ManageScreen
import com.senseplane.app.ui.MatterScreen
import com.senseplane.app.ui.ModeScreen
import com.senseplane.app.ui.NewWatchScreen
import com.senseplane.app.ui.PairScreen
import com.senseplane.app.ui.PermissionsScreen
import com.senseplane.app.ui.SenseplaneTheme
import com.senseplane.app.ui.SensorsScreen
import com.senseplane.app.ui.SettingsScreen
import com.senseplane.app.ui.SignInScreen
import com.senseplane.app.ui.WelcomeScreen

/**
 * The Senseplane app (ADR 0064): get started (pair with a code, choose what
 * the phone does), then the phone tab (its camera, IP cameras, sensors), and
 * for owners and admins who sign in, chat, activity, cameras and watches.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val prefs = Prefs(this)
        // A phone set up before keeps working: the service starts with the app (and runs on with the screen off).
        if (prefs.onboarded && prefs.server.isNotEmpty()) BoxHolder.start(this)
        setContent {
            SenseplaneTheme {
                val nav = rememberNavController()
                val start = remember { if (prefs.onboarded && prefs.server.isNotEmpty()) "home" else "welcome" }
                Routes(nav, start)
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun Routes(nav: NavHostController, start: String) {
    fun go(route: String) = nav.navigate(route)
    fun home() = nav.navigate("home") { popUpTo(0) }
    NavHost(nav, startDestination = start) {
        composable("welcome") { WelcomeScreen(onStart = { go("pair") }) }
        composable("pair") { PairScreen(onBack = { nav.popBackStack() }, onPaired = { nav.navigate("mode") { popUpTo("welcome") } }) }
        composable("mode") { ModeScreen(onBack = { nav.popBackStack() }, onNext = { go("permissions") }) }
        composable("permissions") { PermissionsScreen(onBack = { nav.popBackStack() }, onDone = { home() }) }
        composable("home") { HomeScreen(go = ::go) }
        composable("camera") { CameraScreen(onBack = { nav.popBackStack() }) }
        composable("cameradetail/{id}") { CameraDetailScreen(it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() }) }
        composable("addcamera") { AddCameraScreen(onBack = { nav.popBackStack() }, onAdded = { nav.popBackStack() }) }
        composable("sensors") { SensorsScreen(onBack = { nav.popBackStack() }, go = ::go) }
        composable("matter") { MatterScreen(onBack = { nav.popBackStack() }, onAdded = { nav.popBackStack() }) }
        composable("settings") { SettingsScreen(onBack = { nav.popBackStack() }, onForgotten = { nav.navigate("welcome") { popUpTo(0) } }, go = ::go) }
        composable("signin") { SignInScreen(onBack = { nav.popBackStack() }, onSignedIn = { nav.navigate("manage") { popUpTo("home") } }) }
        composable("manage") { ManageScreen(go = ::go, onSignedOut = { home() }) }
        composable("event/{id}") { EventScreen(it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() }) }
        composable("newwatch") { NewWatchScreen(onBack = { nav.popBackStack() }, onCreated = { nav.popBackStack() }) }
    }
}
