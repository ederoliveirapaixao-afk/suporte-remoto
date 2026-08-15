# Deploy (git → link público em HTTPS)

## 1. Subir para o GitHub
```bash
cd mvp-suporte-remoto
git init
git add .
git commit -m "MVP suporte remoto"
gh repo create suporte-remoto --private --source=. --push
# sem gh cli: crie o repo manualmente no GitHub e rode
# git remote add origin git@github.com:SEU_USUARIO/suporte-remoto.git
# git branch -M main && git push -u origin main
```

## 2. Deploy do backend (Render — detecta o `render.yaml` sozinho)
1. https://render.com → **New > Blueprint** → selecione o repo → Render lê `render.yaml` e cria o serviço.
2. Antes de aplicar, gere o hash da senha do admin localmente:
   ```bash
   cd server && npm install && node scripts/hash-password.js "sua-senha-forte"
   ```
3. Cole o hash gerado na env var `ADMIN_PASSWORD_HASH` do serviço no painel do Render.
4. Deploy conclui em ~2min e Render já entrega o link público em HTTPS, ex:
   `https://suporte-remoto.onrender.com`
   Painel admin: `https://suporte-remoto.onrender.com/admin`

Render já cobre HTTPS automático — **não precisa** do Caddy/`docker-compose.yml` neste caminho (esses ficam só para quem prefere hospedar em VPS própria).

## 3. TURN (obrigatório para funcionar fora de Wi-Fi aberto)
Render não roda `coturn` (exige rede UDP/host que a plataforma não expõe). Caminho mais simples: usar um TURN gerenciado gratuito para o MVP.

1. Crie conta grátis em https://www.metered.ca/tools/openrelay/ (free tier, sem cartão)
2. Pegue `TURN_HOST`, `TURN_USER`, `TURN_PASS` fornecidos
3. No Render, preencha essas 3 env vars no serviço → redeploy automático

Se depois quiser TURN próprio (mais controle, sem depender de terceiro), use o `docker-compose.yml` + `coturn/` deste repo numa VPS (não em Render/Railway).

## 4. Atualizar o app Android
Em `android-app/.../ApiClient.kt`, troque:
```kotlin
const val BASE_URL = "https://suporte-remoto.onrender.com"
```
Recompile o APK no Android Studio.

## 5. Testar o fluxo
1. Login em `/admin` com o usuário/senha configurados
2. Criar sessão → copiar link
3. Abrir o link no celular Android com o app instalado
4. Autorizar → tela aparece ao vivo no painel
