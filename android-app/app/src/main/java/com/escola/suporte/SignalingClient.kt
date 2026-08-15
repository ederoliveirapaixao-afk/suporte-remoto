package com.escola.suporte

import okhttp3.*
import org.json.JSONObject

/**
 * Conexão WebSocket com o backend para troca de sinalização WebRTC
 * (offer/answer/ICE) e recebimento dos comandos de controle remoto.
 */
class SignalingClient(
    private val token: String,
    private val wsBaseUrl: String, // ex: wss://SEU-BACKEND.exemplo.com
    private val listener: Listener
) {
    interface Listener {
        fun onAnswer(sdp: String)
        fun onIceCandidate(sdpMid: String?, sdpMLineIndex: Int, candidate: String)
        fun onControlCommand(json: JSONObject)
        fun onSessionEnded()
    }

    private val client = OkHttpClient()
    private var ws: WebSocket? = null

    fun connect() {
        val request = Request.Builder()
            .url("$wsBaseUrl/ws?role=student&token=$token")
            .build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val json = JSONObject(text)
                when (json.optString("type")) {
                    "webrtc-answer" -> listener.onAnswer(json.getString("sdp"))
                    "webrtc-ice" -> {
                        val c = json.getJSONObject("candidate")
                        listener.onIceCandidate(
                            c.optString("sdpMid"),
                            c.optInt("sdpMLineIndex"),
                            c.getString("candidate")
                        )
                    }
                    "tap", "swipe" -> listener.onControlCommand(json)
                    "session-ended" -> listener.onSessionEnded()
                }
            }
        })
    }

    fun sendOffer(sdp: String) {
        send(JSONObject().put("type", "webrtc-offer").put("sdp", sdp))
    }

    fun sendIceCandidate(sdpMid: String?, sdpMLineIndex: Int, candidate: String) {
        val c = JSONObject()
            .put("sdpMid", sdpMid)
            .put("sdpMLineIndex", sdpMLineIndex)
            .put("candidate", candidate)
        send(JSONObject().put("type", "webrtc-ice").put("candidate", c))
    }

    private fun send(json: JSONObject) {
        ws?.send(json.toString())
    }

    fun close() {
        ws?.close(1000, "encerrado")
    }
}
