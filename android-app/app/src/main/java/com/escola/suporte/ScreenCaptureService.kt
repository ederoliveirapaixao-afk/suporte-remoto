package com.escola.suporte

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.DisplayMetrics
import android.view.Surface
import android.view.WindowManager
import org.json.JSONObject
import org.webrtc.*
import java.io.File

/**
 * Serviço em primeiro plano responsável por:
 * 1. Uma única MediaProjection, usada para criar DUAS VirtualDisplay:
 *    - uma alimenta o WebRTC (tempo real para o admin)
 *    - outra alimenta o MediaRecorder (gravação local)
 * 2. Ao encerrar, envia a gravação para o backend e apaga o arquivo local.
 *
 * Duas VirtualDisplay a partir da MESMA MediaProjection é a forma
 * suportada oficialmente pelo Android para múltiplos consumidores de tela,
 * então não há necessidade de duplicar frames manualmente nem de pedir
 * uma segunda permissão ao usuário.
 */
class ScreenCaptureService : Service() {

    companion object {
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_TOKEN = "token"
        private const val NOTIFICATION_ID = 1
        private const val CHANNEL_ID = "screen_capture"
    }

    private var mediaProjection: MediaProjection? = null
    private var peerConnectionFactory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var signalingClient: SignalingClient? = null
    private var mediaRecorder: MediaRecorder? = null
    private var recordingFile: File? = null
    private var sessionToken: String? = null

    private var eglBase: EglBase? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var webRtcVirtualDisplay: VirtualDisplay? = null
    private var recordingVirtualDisplay: VirtualDisplay? = null

    private var screenWidth = 0
    private var screenHeight = 0
    private var screenDensity = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundWithNotification()

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
            ?: return START_NOT_STICKY
        val resultData = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA) ?: return START_NOT_STICKY
        sessionToken = intent.getStringExtra(EXTRA_TOKEN)

        readScreenMetrics()

        val projectionManager = getSystemService(MediaProjectionManager::class.java)
        mediaProjection = projectionManager.getMediaProjection(resultCode, resultData)
        mediaProjection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                // Usuário revogou a captura (ex: painel rápido do Android) -> encerra tudo
                stopSelf()
            }
        }, null)

        setupRecording()
        connectSignaling()
        ApiClient.fetchIceServers { iceServers -> setupWebRtcTrack(iceServers) }

        RemoteControlAccessibilityService.currentScreenService = this
        sessionToken?.let { ApiClient.notifySessionStarted(it) {} }

        return START_STICKY
    }

    private fun readScreenMetrics() {
        val metrics = DisplayMetrics()
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        screenWidth = metrics.widthPixels
        screenHeight = metrics.heightPixels
        screenDensity = metrics.densityDpi
    }

    // -------- WebRTC: VirtualDisplay #1 -> Surface -> VideoSource --------
    private fun setupWebRtcTrack(iceServers: List<PeerConnection.IceServer>) {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions()
        )
        peerConnectionFactory = PeerConnectionFactory.builder().createPeerConnectionFactory()

        eglBase = EglBase.create()
        surfaceTextureHelper = SurfaceTextureHelper.create("CaptureThread", eglBase!!.eglBaseContext)
        surfaceTextureHelper!!.setTextureSize(screenWidth, screenHeight)

        videoSource = peerConnectionFactory!!.createVideoSource(true)
        surfaceTextureHelper!!.startListening { frame ->
            videoSource!!.capturerObserver.onFrameCaptured(frame)
        }

        val surface = Surface(surfaceTextureHelper!!.surfaceTexture)
        webRtcVirtualDisplay = mediaProjection!!.createVirtualDisplay(
            "SuporteRemoto-WebRTC",
            screenWidth, screenHeight, screenDensity,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            surface, null, null
        )

        val videoTrack = peerConnectionFactory!!.createVideoTrack("screen0", videoSource)

        val rtcConfig = PeerConnection.RTCConfiguration(iceServers)

        peerConnection = peerConnectionFactory!!.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                signalingClient?.sendIceCandidate(candidate.sdpMid, candidate.sdpMLineIndex, candidate.sdp)
            }
            override fun onDataChannel(dc: DataChannel) {
                dc.registerObserver(object : DataChannel.Observer {
                    override fun onMessage(buffer: DataChannel.Buffer) {
                        val bytes = ByteArray(buffer.data.remaining())
                        buffer.data.get(bytes)
                        RemoteControlAccessibilityService.instance?.handleCommand(JSONObject(String(bytes)))
                    }
                    override fun onStateChange() {}
                    override fun onBufferedAmountChange(p0: Long) {}
                })
            }
            override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(p0: Boolean) {}
            override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
            override fun onAddStream(p0: MediaStream?) {}
            override fun onRemoveStream(p0: MediaStream?) {}
            override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
            override fun onRenegotiationNeeded() {}
            override fun onTrack(transceiver: RtpTransceiver?) {}
        })

        peerConnection?.addTrack(videoTrack)

        peerConnection?.createOffer(object : SdpObserverAdapter() {
          override fun onCreateSuccess(desc: SessionDescription?) {
        if (desc == null) return
        peerConnection?.setLocalDescription(SdpObserverAdapter(), desc)
                signalingClient?.sendOffer(desc.description)
            }
        }, MediaConstraints())
    }

    // -------- Gravação: VirtualDisplay #2 -> Surface do MediaRecorder --------
    private fun setupRecording() {
        recordingFile = File(cacheDir, "sessao_${sessionToken}_${System.currentTimeMillis()}.mp4")
        mediaRecorder = MediaRecorder().apply {
            setVideoSource(MediaRecorder.VideoSource.SURFACE)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setVideoEncoder(MediaRecorder.VideoEncoder.H264)
            setVideoSize(screenWidth, screenHeight)
            setVideoFrameRate(30)
            setVideoEncodingBitRate(4_000_000)
            setOutputFile(recordingFile!!.absolutePath)
            prepare()
        }

        recordingVirtualDisplay = mediaProjection!!.createVirtualDisplay(
            "SuporteRemoto-Gravacao",
            screenWidth, screenHeight, screenDensity,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            mediaRecorder!!.surface, null, null
        )

        mediaRecorder!!.start()
    }

    private fun connectSignaling() {
        val token = sessionToken ?: return
        signalingClient = SignalingClient(
            token = token,
            wsBaseUrl = ApiClient.BASE_URL.replace("https://", "wss://").replace("http://", "ws://"),
            listener = object : SignalingClient.Listener {
                override fun onAnswer(sdp: String) {
                    peerConnection?.setRemoteDescription(
                        SdpObserverAdapter(), SessionDescription(SessionDescription.Type.ANSWER, sdp)
                    )
                }
                override fun onIceCandidate(sdpMid: String?, sdpMLineIndex: Int, candidate: String) {
                    peerConnection?.addIceCandidate(IceCandidate(sdpMid, sdpMLineIndex, candidate))
                }
                override fun onControlCommand(json: JSONObject) {
                    RemoteControlAccessibilityService.instance?.handleCommand(json)
                }
                override fun onSessionEnded() {
                    stopSelf()
                }
            }
        )
        signalingClient?.connect()
    }

    private fun startForegroundWithNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "Suporte remoto ativo", NotificationManager.IMPORTANCE_HIGH
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Sessão de suporte ativa")
            .setContentText("Sua tela está sendo compartilhada e gravada.")
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        finishRecordingAndUpload()

        webRtcVirtualDisplay?.release()
        recordingVirtualDisplay?.release()
        surfaceTextureHelper?.stopListening()
        surfaceTextureHelper?.dispose()
        eglBase?.release()
        videoSource?.dispose()
        peerConnection?.close()
        mediaProjection?.stop()
        signalingClient?.close()
        RemoteControlAccessibilityService.currentScreenService = null
    }

    private fun finishRecordingAndUpload() {
        try {
            mediaRecorder?.stop()
            mediaRecorder?.release()
        } catch (e: Exception) { /* gravação pode não ter chegado a iniciar */ }

        val file = recordingFile ?: return
        val token = sessionToken ?: return
        if (file.exists()) {
            ApiClient.uploadRecording(token, file) { success ->
                if (success) file.delete()
            }
        }
    }
}

// Adapter para não precisar implementar todos os métodos de SdpObserver toda vez
open class SdpObserverAdapter : SdpObserver {
    override fun onCreateSuccess(p0: SessionDescription?) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(p0: String?) {}
    override fun onSetFailure(p0: String?) {}
}
