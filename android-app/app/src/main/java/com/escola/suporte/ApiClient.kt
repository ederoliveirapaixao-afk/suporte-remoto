package com.escola.suporte

import org.json.JSONObject
import org.webrtc.PeerConnection
import java.io.File
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Cliente HTTP minimalista (sem dependências externas) para os endpoints
 * públicos do backend usados pelo app do aluno.
 */
object ApiClient {

    // Troque pelo domínio real do backend em produção.
    const val BASE_URL = "https://SEU-BACKEND.exemplo.com"

    private val executor = Executors.newCachedThreadPool()

    fun authorizeSession(token: String, callback: (Boolean) -> Unit) {
        executor.execute {
            val ok = postJson("$BASE_URL/api/public/sessions/$token/authorize", "{}")
            callback(ok)
        }
    }

    fun notifySessionStarted(token: String, callback: (Boolean) -> Unit) {
        executor.execute {
            val ok = postJson("$BASE_URL/api/public/sessions/$token/start", "{}")
            callback(ok)
        }
    }

    fun uploadRecording(token: String, file: File, callback: (Boolean) -> Unit) {
        executor.execute {
            val ok = uploadMultipart("$BASE_URL/api/public/sessions/$token/recording", file)
            callback(ok)
        }
    }

    /** Busca STUN/TURN do backend (mesma fonte usada pelo painel admin). */
    fun fetchIceServers(callback: (List<PeerConnection.IceServer>) -> Unit) {
        executor.execute {
            val fallback = listOf(
                PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
            )
            try {
                val conn = URL("$BASE_URL/api/ice-servers").openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                val body = conn.inputStream.bufferedReader().readText()
                conn.disconnect()
                val arr = JSONObject(body).getJSONArray("iceServers")
                val servers = mutableListOf<PeerConnection.IceServer>()
                for (i in 0 until arr.length()) {
                    val s = arr.getJSONObject(i)
                    val builder = PeerConnection.IceServer.builder(s.getString("urls"))
                    if (s.has("username")) builder.setUsername(s.getString("username"))
                    if (s.has("credential")) builder.setPassword(s.getString("credential"))
                    servers.add(builder.createIceServer())
                }
                callback(if (servers.isEmpty()) fallback else servers)
            } catch (e: Exception) {
                callback(fallback)
            }
        }
    }

    private fun postJson(urlStr: String, body: String): Boolean {
        return try {
            val conn = URL(urlStr).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            conn.disconnect()
            code in 200..299
        } catch (e: Exception) {
            false
        }
    }

    private fun uploadMultipart(urlStr: String, file: File): Boolean {
        val boundary = "----SuporteRemoto${System.currentTimeMillis()}"
        return try {
            val conn = URL(urlStr).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")

            val out: OutputStream = conn.outputStream
            out.write("--$boundary\r\n".toByteArray())
            out.write("Content-Disposition: form-data; name=\"video\"; filename=\"${file.name}\"\r\n".toByteArray())
            out.write("Content-Type: video/mp4\r\n\r\n".toByteArray())
            file.inputStream().use { it.copyTo(out) }
            out.write("\r\n--$boundary--\r\n".toByteArray())
            out.flush()

            val code = conn.responseCode
            conn.disconnect()
            code in 200..299
        } catch (e: Exception) {
            false
        }
    }
}
