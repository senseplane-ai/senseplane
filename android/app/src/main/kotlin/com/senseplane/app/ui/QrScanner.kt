// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.senseplane.app.box.QrCodes
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The back camera, reading QR codes until it sees a Matter one (MT:…).
 * Nothing is kept: frames are only looked at. When the camera is busy
 * (this phone sending its own video) it says so and the code can be typed.
 */
@Composable
fun QrScanner(onCode: (String) -> Unit, onError: (String) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val found = remember { AtomicBoolean(false) }
    val provider = remember { ProcessCameraProvider.getInstance(context) }
    DisposableEffect(Unit) {
        onDispose {
            runCatching { if (provider.isDone) provider.get().unbindAll() }
            executor.shutdown()
        }
    }
    AndroidView(
        modifier = Modifier.fillMaxWidth().height(260.dp).clip(RoundedCornerShape(10.dp)),
        factory = { ctx ->
            PreviewView(ctx).also { view ->
                provider.addListener({
                    val p = provider.get()
                    val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                    val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                    analysis.setAnalyzer(executor) { image ->
                        try {
                            val y = image.planes[0]
                            val buf = y.buffer
                            val bytes = ByteArray(buf.remaining()).also { buf.get(it) }
                            val code = QrCodes.matter(QrCodes.decode(bytes, image.width, image.height, y.rowStride))
                            if (code != null && found.compareAndSet(false, true)) {
                                ContextCompat.getMainExecutor(ctx).execute { onCode(code) }
                            }
                        } finally {
                            image.close()
                        }
                    }
                    runCatching {
                        p.unbindAll()
                        p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                    }.onFailure { onError("The camera is busy (this phone may be sending its video). Type the code under the QR code instead.") }
                }, ContextCompat.getMainExecutor(ctx))
            }
        },
    )
}
