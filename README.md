# deepgram-twilio-voice

Puente entre **Twilio Media Streams** y la **Voice Agent API de Deepgram**, en Node.js con Fastify.
Quien llame a tu número de Twilio habla directamente con un agente de voz.

Es el equivalente en Node del ejemplo [deepgram-devs/sts-twilio](https://github.com/deepgram-devs/sts-twilio) (Python).

## Cómo funciona

```
Llamada  ──▶  Twilio  ──▶  POST /twiml   ──▶  <Connect><Stream url="wss://…/twilio">
                             │
                             ▼
                     WS /twilio  ◀────────▶  wss://agent.deepgram.com/v1/agent/converse
                     (Fastify)                (Deepgram Voice Agent)
```

Los dos extremos hablan **mulaw a 8 kHz**, así que el audio se reenvía sin transcodificar:
solo cambia el envoltorio (base64 dentro de JSON en el lado Twilio, frames binarios en el
lado Deepgram). El audio entrante se agrupa en bloques de 400 ms (20 tramas de 160 bytes)
antes de mandarlo a Deepgram, para no hacer una escritura de socket cada 20 ms.

Cuando Deepgram avisa de un `UserStartedSpeaking`, el servidor manda un `clear` a Twilio para
descartar el audio del agente que quede en el búfer de reproducción: eso es el **barge-in**,
lo que permite interrumpir al agente hablándole encima.

## Endpoints

| Ruta      | Método    | Para qué sirve                                                     |
| --------- | --------- | ------------------------------------------------------------------ |
| `/twiml`  | POST, GET | Devuelve el TwiML que abre el Media Stream. Es el webhook de voz.   |
| `/twilio` | WebSocket | El puente de audio propiamente dicho.                               |
| `/health` | GET       | Comprobación de vida.                                               |

## Puesta en marcha

```bash
npm install
cp .env.example .env   # y rellena DEEPGRAM_API_KEY
npm run dev
```

El servidor queda en `http://localhost:5000`.

### Exponerlo a Twilio

Twilio necesita alcanzar tu máquina por HTTPS/WSS, así que en local hace falta un túnel:

```bash
ngrok http 5000
```

En la consola de Twilio, en tu número → **Voice & Fax → A call comes in**, elige *Webhook* y
apunta a `https://TU-SUBDOMINIO.ngrok.app/twiml` (método POST).

No hace falta configurar la URL del websocket en ningún sitio: `/twiml` la deriva del header
`Host` de la propia petición de Twilio. Si prefieres fijarla (por ejemplo detrás de un load
balancer que reescribe el `Host`), pon `PUBLIC_WS_URL=wss://tu-dominio/twilio` en el `.env`.

Ya puedes llamar al número.

### Alternativa: TwiML Bin

Si prefieres mantener el TwiML en Twilio en lugar de servirlo desde aquí, crea un TwiML Bin
con este contenido y asígnalo al número:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://TU-SUBDOMINIO.ngrok.app/twilio" />
  </Connect>
</Response>
```

## Probar sin hacer una llamada

Hay un simulador que se hace pasar por Twilio: manda los eventos `connected` / `start` y luego
silencio en mulaw a ritmo real, y cuenta el audio que devuelve el agente.

```bash
npm run simulate
```

Con el servidor levantado y una `DEEPGRAM_API_KEY` válida deberías ver llegar el saludo:

```
Conectado a ws://localhost:5000/twilio
Primer audio del agente recibido

Cerrado. 42 mensajes de audio, 25600 bytes (~3200 ms de voz).
OK: el agente respondió.
```

Acepta una URL y una duración: `node scripts/simulate-twilio.js ws://localhost:5000/twilio 15`.

## Configuración del agente

Todo se ajusta por variables de entorno (ver `.env.example`), sin tocar código:

| Variable            | Por defecto          | Qué controla                                   |
| ------------------- | -------------------- | ---------------------------------------------- |
| `AGENT_LANGUAGE`    | `en`                 | Idioma de la conversación                      |
| `AGENT_GREETING`    | *(saludo en inglés)* | Lo primero que dice el agente al descolgar     |
| `AGENT_PROMPT`      | *(asistente de soporte)* | Instrucciones de sistema del LLM           |
| `LISTEN_MODEL`      | `nova-3`             | Modelo de transcripción                        |
| `THINK_PROVIDER`    | `open_ai`            | Proveedor del LLM                              |
| `THINK_MODEL`       | `gpt-4o-mini`        | Modelo del LLM                                 |
| `THINK_TEMPERATURE` | `0.7`                | Temperatura del LLM                            |
| `SPEAK_MODEL`       | `aura-2-thalia-en`   | Voz de síntesis                                |

Para un agente en español, por ejemplo:

```env
AGENT_LANGUAGE=es
AGENT_GREETING=¡Hola! ¿En qué puedo ayudarte?
AGENT_PROMPT=Eres un asistente de atención al cliente. Responde de forma breve y natural, estás hablando por teléfono.
SPEAK_MODEL=aura-2-celeste-es
```

Si necesitas ir más allá (function calling, contexto previo, endpoints LLM propios), el mensaje
de configuración se construye en [`src/agent-settings.js`](src/agent-settings.js); el esquema
completo está en la [documentación de Deepgram](https://developers.deepgram.com/docs/configure-voice-agent).

## Estructura

```
src/
├── server.js                  arranque y apagado ordenado
├── app.js                     instancia de Fastify y registro de plugins/rutas
├── config.js                  variables de entorno
├── agent-settings.js          mensaje Settings de Deepgram
├── deepgram-agent.js          cliente del Voice Agent (cola, keep-alive, eventos)
└── routes/
    ├── twiml.js               webhook de voz
    └── twilio-stream.js       puente de audio bidireccional
scripts/
└── simulate-twilio.js         cliente de pruebas que imita a Twilio
```

## Notas

- El audio se pone en cola mientras la sesión de Deepgram se negocia (`Welcome` → `Settings`),
  así no se pierden los primeros milisegundos de la llamada. Lo mismo al revés: si el saludo
  del agente llega antes que el evento `start` de Twilio, se guarda hasta conocer el `streamSid`.
- Se manda un `KeepAlive` cada 8 s para que Deepgram no cierre la sesión en silencios largos.
- Cerrar cualquiera de los dos extremos cierra el otro.
