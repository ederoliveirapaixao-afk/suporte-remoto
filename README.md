# MVP — Suporte Remoto para Alunos (Android)

## Arquitetura (por que essa e não outra)

Não dá pra fazer isso 100% web. Resumo técnico:

| Peça | Tecnologia | Por quê |
|---|---|---|
| Backend | Node.js + Express + WebSocket | Sessões, links, sinalização WebRTC (relay), upload/armazenamento de gravação |
| Painel Admin | PWA (HTML/JS puro, sem build) | Só precisa de CRUD, WebRTC (`RTCPeerConnection` nativo do navegador) e um player de vídeo |
| App do Aluno | **Android nativo (Kotlin)** | Ver tela em tempo real e controlar o aparelho **exige** `MediaProjection` e `AccessibilityService`, que só existem para apps instalados. Não existe equivalente web. |

### Por que não dá pra fazer via navegador no aluno
- **Ver a tela em tempo real**: exigiria capturar a tela inteira do sistema operacional. `getDisplayMedia` do navegador captura no máximo a própria aba/janela do navegador — não a tela do celular. A única API do Android para isso é `MediaProjection`, exclusiva de apps nativos.
- **Controlar o dispositivo**: a única API pública do Android para injetar toques em outros apps é `AccessibilityService.dispatchGesture()`. Não existe forma de fazer isso a partir de uma página web.
- **Ativar essas permissões "tudo de uma vez"**: o Android **bloqueia isso de propósito**. `MediaProjection` sempre mostra um diálogo de sistema por sessão; `AccessibilityService` só pode ser ativado manualmente pelo usuário em Ajustes. É assim que o Android impede apps de vigilância silenciosa — não há alternativa técnica válida, e qualquer solução que dissesse "ativa tudo automaticamente" estaria mentindo sobre como o Android funciona (ou usando uma brecha que o Google Play bane).

## Rodando o backend hoje

```bash
cd server
npm install
node scripts/hash-password.js "sua-senha-forte"   # copie o hash gerado
ADMIN_USERNAME=admin ADMIN_PASSWORD_HASH='<hash-gerado>' JWT_SECRET=$(openssl rand -hex 32) npm start
```

Abra `http://localhost:3000/admin`, faça login, crie uma sessão, copie o link.

### Produção com Docker (HTTPS automático + TURN)
```bash
cp .env.example .env   # preencha DOMAIN, ADMIN_PASSWORD_HASH, JWT_SECRET, TURN_*
docker compose up --build -d
```
`Caddy` cuida do certificado TLS sozinho (Let's Encrypt) a partir do `DOMAIN`. `coturn` garante que a conexão funcione em redes de escola com NAT restritivo, onde STUN sozinho falha.

## Rodando o app Android

1. Abra `android-app/` no Android Studio (Hedgehog+).
2. Ajuste `ApiClient.BASE_URL` para o endereço público do seu backend (em produção precisa ser HTTPS — WebRTC e MediaProjection exigem contexto seguro).
3. `Sync Gradle` (baixa `google-webrtc`, `okhttp`, `json`).
4. Rode num aparelho físico Android 10+ (API 29+) — emulador não expõe câmera/tela de forma confiável para este fluxo.

## O que está pronto e funcional
- Criação de sessão, link único, autorização, histórico — **completo e testável hoje**.
- Sinalização WebRTC via WebSocket — **completo**.
- Fluxo de consentimento em 2 etapas no Android (MediaProjection + Accessibility) — **completo e correto conforme as APIs reais do Android**.
- Envio de comandos de toque do admin → dispatchGesture no aluno — **completo**.
- Upload de gravação e player restrito ao admin — **completo**.

## O que falta para virar produção
1. **Play Store**: apps que usam `AccessibilityService` para controle remoto passam por revisão manual da Google (política de uso restrito) — é preciso declarar o uso e justificar, mesmo caminho que TeamViewer QuickSupport/AnyDesk seguem.
2. **Renovação por sessão**: já é automática — o Android expira a `MediaProjection` ao fechar o serviço/app, não é contornável nem precisa de código adicional.
