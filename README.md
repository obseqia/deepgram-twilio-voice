# deepgram-twilio-voice

Puente entre **Twilio Media Streams** y la **Voice Agent API de Deepgram**, en Node.js con Fastify.
Quien llame a tu número de Twilio habla con un agente de voz **bilingüe español/inglés**: detecta
en qué idioma le hablan y contesta en ese mismo idioma, aunque el interlocutor cambie a mitad de
la llamada.

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

## Multilenguaje

Que un agente sea bilingüe de verdad depende de tres piezas, y las tres tienen que estar de
acuerdo. Es fácil configurar solo una y acabar con un agente que entiende español pero
responde en inglés, o que dice las palabras correctas con la fonética equivocada.

**1. Escuchar** — `flux-general-multi`, el modelo conversacional de Deepgram. Entiende los
turnos de palabra, así que detecta el final de frase y las interrupciones bastante mejor que
Nova en una llamada. Se le pasan `language_hints` para sesgarlo hacia los idiomas esperados:
sin ellos autodetecta, pero fallar el idioma en la primera frase se nota mucho.

**2. Pensar** — al prompt se le añade automáticamente una directiva que le dice al LLM que
responda siempre en el idioma del interlocutor. Sin ella el modelo tiende a contestar en el
idioma del prompt de sistema por bien que el STT haya transcrito la otra lengua.

**3. Hablar** — aquí está la trampa. Cada voz de Aura-2 está atada a un idioma (el sufijo del
nombre: `aura-2-thalia-en`). Una voz inglesa dirá una frase en español, pero leyéndola como si
fuera inglés. **Solo cinco voces españolas alternan los dos idiomas dentro de una misma
respuesta**: aquila, carina, diana, javier y selena. Por eso el valor por defecto es
`aura-2-diana-es` y no una voz inglesa.

El servidor comprueba al arrancar que la voz elegida cubre los idiomas configurados, y avisa
por log con alternativas concretas si no es así:

```
WARN: La voz aura-2-thalia-en no hace code-switching en/es: leerá el otro idioma
      con la fonética equivocada.
WARN: Voces que sí lo hacen: aura-2-aquila-es (masculina — expresiva, entusiasta, cercana) · …
```

Para pares de idiomas que Deepgram no cubre con una sola voz (inglés/francés, por ejemplo), el
aviso lo dice y remite a un proveedor de TTS externo con `speak.provider.language: "multi"`.

Nota: el campo `agent.language` de la API está deprecado y este proyecto no lo envía; el idioma
se configura por proveedor (`language_hints` al escuchar, voz nativa al hablar).

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

Hay un simulador que se hace pasar por Twilio: manda los eventos `connected` / `start`, envía
audio a ritmo real y guarda la respuesta del agente en un WAV que puedes escuchar.

```bash
npm run simulate
```

Sin argumentos manda silencio, así que solo comprueba que llega el saludo. Para probar una
conversación de verdad hace falta una pregunta grabada en mulaw 8 kHz mono:

```bash
ffmpeg -i pregunta.m4a -ar 8000 -ac 1 -f mulaw pregunta.raw
node scripts/simulate-twilio.js --audio pregunta.raw --out respuesta.wav
afplay respuesta.wav
```

| Opción      | Por defecto            | Qué hace                                                     |
| ----------- | ---------------------- | ------------------------------------------------------------ |
| `--url`     | `ws://localhost:5000/twilio` | A dónde conectarse                                     |
| `--audio`   | *(silencio)*           | Fichero mulaw 8 kHz que se envía como voz del llamante       |
| `--delay`   | `6` con audio, `0` sin | Segundos de silencio antes de hablar, para dejar pasar el saludo. Con `0` la pregunta pisa al agente: así se prueba el barge-in |
| `--seconds` | `25` con audio, `10` sin | Duración total de la llamada simulada                      |
| `--out`     | `respuesta-agente.wav` | Dónde guardar el audio del agente                            |

Si no tienes nada grabado, el propio TTS de Deepgram sirve para generar las preguntas:

```bash
curl -X POST "https://api.deepgram.com/v1/speak?model=aura-2-javier-es&encoding=mulaw&sample_rate=8000&container=none" \
  -H "Authorization: Token $DEEPGRAM_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"Hola, ¿cuál es el horario de atención al cliente?"}' \
  --output pregunta-es.raw
```

Mientras corre, el log del servidor muestra cada turno con el idioma que detectó, que es la
forma de ver el code-switching funcionando:

```
[es] user      : Hola, buenos días. ¿Cuál es el horario de atención al cliente?
[ - ] assistant : Nuestro horario de atención al cliente es de lunes a viernes, de 9 a 5.
[en] user      : Hi there. What are your customer service hours?
[ - ] assistant : Our customer service hours are Monday to Friday, from 9 AM to 5 PM.
```

## Usar tus propios modelos (DigitalOcean y otros)

Por defecto el LLM lo pone Deepgram. Para usar tus modelos de **DigitalOcean Serverless
Inference** basta con:

```env
THINK_PROVIDER=digitalocean
THINK_MODEL=llama3.3-70b-instruct
DIGITALOCEAN_MODEL_ACCESS_KEY=tu_clave
```

La clave se crea en la consola de DigitalOcean, en *Gradient AI → Serverless Inference →
Model access keys*. Para ver qué modelos tienes disponibles y comprobar que la clave funciona
antes de gastar una llamada entera:

```bash
npm run models          # lista los modelos del endpoint
npm run models -- --test  # además pregunta algo al de THINK_MODEL y cronometra la respuesta
```

Como el servicio es compatible con OpenAI, lo mismo vale para cualquier otro (Groq, Together,
OpenRouter, un vLLM propio…):

```env
THINK_ENDPOINT_URL=https://tu-servicio/v1/chat/completions
THINK_API_KEY=tu_clave
THINK_MODEL=el-modelo
```

Dos cosas que conviene tener claras, porque no son evidentes:

- **Quien llama al LLM es Deepgram, no este servidor.** El endpoint tiene que ser accesible
  desde internet: un `localhost` o una IP privada no funcionan.
- **La clave viaja hasta Deepgram** dentro del mensaje `Settings`, ya que son ellos quienes
  autentican contra tu endpoint. Usa una clave dedicada y revocable, no la principal.

Para comparar modelos, cambiar `THINK_MODEL` y repetir la misma pregunta grabada con el
simulador da una comparación bastante honesta: el log del servidor lleva marca de tiempo en
cada turno, así que se ve tanto la calidad de la respuesta como lo que tarda en llegar.

## Configuración

Todo se ajusta por variables de entorno (ver `.env.example`), sin tocar código:

| Variable            | Por defecto             | Qué controla                                        |
| ------------------- | ----------------------- | --------------------------------------------------- |
| `AGENT_LANGUAGES`   | `en,es`                 | Idiomas que entiende y habla, separados por coma     |
| `AGENT_GREETING`    | *(saludo bilingüe)*     | Lo primero que dice al descolgar                     |
| `AGENT_PROMPT`      | *(asistente de soporte)*| Instrucciones de sistema (la directiva de idioma se añade sola) |
| `LISTEN_MODEL`      | *(automático)*          | Vacío elige `flux-general-en` o `flux-general-multi` según los idiomas. `nova-3` como escotilla de salida |
| `THINK_PROVIDER`    | `open_ai`               | `open_ai`/`anthropic`/`google` usan el LLM de Deepgram; `digitalocean` usa el tuyo |
| `THINK_MODEL`       | `gpt-4o-mini`           | Modelo del LLM                                       |
| `THINK_TEMPERATURE` | `0.7`                   | Temperatura del LLM                                  |
| `DIGITALOCEAN_MODEL_ACCESS_KEY` | —           | Clave de DigitalOcean Serverless Inference           |
| `THINK_ENDPOINT_URL` / `THINK_API_KEY` | —    | Cualquier otro endpoint compatible con OpenAI        |
| `SPEAK_MODEL`       | `aura-2-diana-es`       | Voz de síntesis                                      |

Para un agente monolingüe en inglés, por ejemplo:

```env
AGENT_LANGUAGES=en
AGENT_GREETING=Hello! How can I help you today?
SPEAK_MODEL=aura-2-thalia-en
```

Si necesitas ir más allá (function calling, contexto previo, endpoints LLM propios), el mensaje
de configuración se construye en [`src/agent-settings.js`](src/agent-settings.js); el esquema
completo está en la [documentación de Deepgram](https://developers.deepgram.com/docs/configure-voice-agent).

## Estructura

```
src/
├── server.js                  arranque, validación y apagado ordenado
├── app.js                     instancia de Fastify y registro de plugins/rutas
├── config.js                  variables de entorno
├── voices.js                  catálogo de voces y validación voz/idiomas
├── agent-settings.js          mensaje Settings de Deepgram
├── deepgram-agent.js          cliente del Voice Agent (cola, keep-alive, eventos)
└── routes/
    ├── twiml.js               webhook de voz
    └── twilio-stream.js       puente de audio bidireccional
scripts/
├── simulate-twilio.js         cliente de pruebas que imita a Twilio
└── list-models.js             lista y prueba los modelos del endpoint propio
```

## Notas

- El audio se pone en cola mientras la sesión de Deepgram se negocia (`Welcome` → `Settings`),
  así no se pierden los primeros milisegundos de la llamada. Lo mismo al revés: si el saludo
  del agente llega antes que el evento `start` de Twilio, se guarda hasta conocer el `streamSid`.
- Se manda un `KeepAlive` cada 8 s para que Deepgram no cierre la sesión en silencios largos.
- Cerrar cualquiera de los dos extremos cierra el otro.
