package com.escola.suporte

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/**
 * Fluxo do aluno:
 * 1. App abre via deep link (suporteapp://autorizar?token=...)
 * 2. Aluno confirma consentimento explícito na tela
 * 3. App chama a API para marcar sessão como "authorized"
 * 4. App pede permissão de captura de tela (MediaProjection) -> diálogo do sistema, obrigatório
 * 5. Se o AccessibilityService (controle remoto) ainda não estiver ativo,
 *    o app leva o aluno até Ajustes para ativar manualmente (não dá para pular essa etapa)
 * 6. Inicia o ScreenCaptureService (transmissão + gravação)
 */
class MainActivity : ComponentActivity() {

    private var sessionToken: String? = null
    private lateinit var projectionManager: MediaProjectionManager

    private val screenCaptureLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == Activity.RESULT_OK && result.data != null) {
                startCaptureService(result.resultCode, result.data!!)
            } else {
                Toast.makeText(this, "Captura de tela não autorizada. Sessão cancelada.", Toast.LENGTH_LONG).show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        projectionManager = getSystemService(MediaProjectionManager::class.java)

        sessionToken = intent?.data?.getQueryParameter("token")

        val info = findViewById<TextView>(R.id.infoText)
        val authorizeBtn = findViewById<Button>(R.id.authorizeButton)

        if (sessionToken == null) {
            info.text = "Link inválido."
            authorizeBtn.isEnabled = false
            return
        }

        info.text = "Você está prestes a iniciar uma sessão de suporte remoto.\n\n" +
                "Durante a sessão, o suporte poderá ver sua tela, controlar o " +
                "dispositivo e a sessão será gravada.\n\n" +
                "Toque em Autorizar para continuar."

        authorizeBtn.setOnClickListener { onAuthorizeClicked() }
    }

    private fun onAuthorizeClicked() {
        val token = sessionToken ?: return
        ApiClient.authorizeSession(token) { success ->
            runOnUiThread {
                if (!success) {
                    Toast.makeText(this, "Falha ao autorizar. Verifique a internet.", Toast.LENGTH_LONG).show()
                    return@runOnUiThread
                }
                ensureAccessibilityThenCapture()
            }
        }
    }

    /**
     * O Android NÃO permite ativar um AccessibilityService por código.
     * É uma restrição de segurança da plataforma (evita apps ativando controle
     * total do dispositivo sem o usuário perceber). Por isso levamos o aluno
     * manualmente até a tela de Ajustes.
     */
    private fun ensureAccessibilityThenCapture() {
        if (isAccessibilityServiceEnabled()) {
            requestScreenCapture()
        } else {
            Toast.makeText(
                this,
                "Agora ative 'Suporte Remoto' na tela de Acessibilidade para permitir o controle do dispositivo.",
                Toast.LENGTH_LONG
            ).show()
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
    }

    override fun onResume() {
        super.onResume()
        // Quando o aluno volta da tela de Ajustes, verificamos se já ativou.
        if (sessionToken != null && isAccessibilityServiceEnabled() && !captureRequested) {
            requestScreenCapture()
        }
    }

    private var captureRequested = false

    private fun requestScreenCapture() {
        captureRequested = true
        screenCaptureLauncher.launch(projectionManager.createScreenCaptureIntent())
    }

    private fun startCaptureService(resultCode: Int, data: Intent) {
        val intent = Intent(this, ScreenCaptureService::class.java).apply {
            putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
            putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data)
            putExtra(ScreenCaptureService.EXTRA_TOKEN, sessionToken)
        }
        startForegroundService(intent)
        finish()
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val expected = "$packageName/${RemoteControlAccessibilityService::class.java.canonicalName}"
        val enabled = Settings.Secure.getString(
            contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val splitter = TextUtils.SimpleStringSplitter(':')
        splitter.setString(enabled)
        while (splitter.hasNext()) {
            if (splitter.next().equals(expected, ignoreCase = true)) return true
        }
        return false
    }
}
