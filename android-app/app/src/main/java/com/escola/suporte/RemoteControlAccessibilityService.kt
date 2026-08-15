package com.escola.suporte

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.util.DisplayMetrics
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import org.json.JSONObject

/**
 * Único mecanismo legítimo no Android para um app injetar toques em OUTROS
 * apps: AccessibilityService.dispatchGesture(). Precisa estar habilitado
 * manualmente pelo aluno em Ajustes > Acessibilidade (ver MainActivity).
 *
 * Recebe comandos {type:"tap", x: 0..1, y: 0..1} vindos do DataChannel
 * WebRTC (coordenadas normalizadas) e converte para pixels reais da tela
 * deste aparelho antes de despachar o gesto.
 */
class RemoteControlAccessibilityService : AccessibilityService() {

    companion object {
        var instance: RemoteControlAccessibilityService? = null
        // referência ao serviço de captura, usada só para fins de coordenação simples no MVP
        var currentScreenService: ScreenCaptureService? = null
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        super.onDestroy()
        instance = null
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // não precisamos reagir a eventos de UI para este MVP
    }

    override fun onInterrupt() {}

    fun handleCommand(json: JSONObject) {
        val metrics = DisplayMetrics()
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)

        when (json.optString("type")) {
            "tap" -> {
                val x = (json.getDouble("x") * metrics.widthPixels).toFloat()
                val y = (json.getDouble("y") * metrics.heightPixels).toFloat()
                dispatchTap(x, y)
            }
            "swipe" -> {
                val x1 = (json.getDouble("x1") * metrics.widthPixels).toFloat()
                val y1 = (json.getDouble("y1") * metrics.heightPixels).toFloat()
                val x2 = (json.getDouble("x2") * metrics.widthPixels).toFloat()
                val y2 = (json.getDouble("y2") * metrics.heightPixels).toFloat()
                dispatchSwipe(x1, y1, x2, y2)
            }
        }
    }

    private fun dispatchTap(x: Float, y: Float) {
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 80))
            .build()
        dispatchGesture(gesture, null, null)
    }

    private fun dispatchSwipe(x1: Float, y1: Float, x2: Float, y2: Float) {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 250))
            .build()
        dispatchGesture(gesture, null, null)
    }
}
