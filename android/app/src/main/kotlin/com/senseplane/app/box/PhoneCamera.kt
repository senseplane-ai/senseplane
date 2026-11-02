// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.box

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.util.Range
import android.view.Surface

/**
 * The phone's back camera, encoded to H.264 by the phone's own encoder and
 * handed to the bridge frame by frame (nothing is re-encoded after this).
 * A preview surface can come and go (the app open or in the background).
 */
class PhoneCamera(
    private val context: Context,
    private val width: Int = 1280,
    private val height: Int = 720,
    private val fps: Int = 15,
    private val bitrate: Int = 2_000_000,
    onFrame: (ByteArray, Long, Boolean) -> Unit,
) {
    private val frames = Frames(fps, onFrame)
    private val thread = HandlerThread("senseplane-camera").apply { start() }
    private val handler = Handler(thread.looper)
    private var codec: MediaCodec? = null
    private var input: Surface? = null
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var preview: Surface? = null
    @Volatile var running = false
        private set
    private var warm = false

    @SuppressLint("MissingPermission") // the app asks for the camera before starting
    fun start() = handler.post {
        if (running) return@post
        running = true
        frames.reset()
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
        }
        val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        c.setCallback(object : MediaCodec.Callback() {
            override fun onInputBufferAvailable(codec: MediaCodec, index: Int) = Unit
            override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
                val buf = codec.getOutputBuffer(index)
                if (buf != null && info.size > 0) {
                    val bytes = ByteArray(info.size)
                    buf.position(info.offset)
                    buf.get(bytes, 0, info.size)
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) frames.onConfig(bytes)
                    else frames.onFrame(bytes, info.presentationTimeUs, info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0)
                }
                codec.releaseOutputBuffer(index, false)
            }
            override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
                Log.w(TAG, "encoder error", e)
            }
            override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) = Unit
        }, handler)
        c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        input = c.createInputSurface()
        c.start()
        codec = c
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
            ?: cm.cameraIdList.firstOrNull()
        if (id == null) {
            Log.w(TAG, "no camera")
            return@post
        }
        cm.openCamera(id, object : CameraDevice.StateCallback() {
            override fun onOpened(camera: CameraDevice) {
                device = camera
                openSession()
            }
            override fun onDisconnected(camera: CameraDevice) {
                camera.close()
                device = null
            }
            override fun onError(camera: CameraDevice, error: Int) {
                Log.w(TAG, "camera error $error")
                camera.close()
                device = null
            }
        }, handler)
    }

    /** Shows the camera on this surface too (null: encode only). */
    fun setPreview(surface: Surface?) = handler.post {
        preview = surface
        if (device != null) openSession()
    }

    @Suppress("DEPRECATION") // createCaptureSession(List) is enough down to API 26
    private fun openSession() {
        val camera = device ?: return
        val enc = input ?: return
        session?.close()
        val targets = listOfNotNull(enc, preview)
        camera.createCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                session = s
                val req = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                    targets.forEach { addTarget(it) }
                    val rate = if (warm) WARM_FPS else fps
                    set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, Range(rate, rate))
                }
                runCatching { s.setRepeatingRequest(req.build(), null, handler) }.onFailure { Log.w(TAG, "capture failed", it) }
            }
            override fun onConfigureFailed(s: CameraCaptureSession) {
                Log.w(TAG, "camera session failed")
            }
        }, handler)
    }

    /**
     * A warm phone sends 10 frames a second at half the bitrate until it cools
     * (Android's thermal status); recordings stay 720p.
     */
    fun setWarm(on: Boolean) = handler.post {
        if (warm == on) return@post
        warm = on
        Log.i(TAG, if (on) "the phone is warm: sending less" else "the phone cooled: sending normally")
        runCatching { codec?.setParameters(android.os.Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, if (on) bitrate / 2 else bitrate) }) }
        if (device != null) openSession()
    }

    fun stop() = handler.post {
        if (!running) return@post
        running = false
        runCatching { session?.close() }
        runCatching { device?.close() }
        runCatching { codec?.stop() }
        runCatching { codec?.release() }
        runCatching { input?.release() }
        session = null; device = null; codec = null; input = null
    }

    fun close() {
        stop()
        thread.quitSafely()
    }

    companion object {
        private const val TAG = "SenseplaneCamera"
        private const val WARM_FPS = 10
    }
}
