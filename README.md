# deepgram-twilio-voice

Puente entre **Twilio Media Streams** y la **Voice Agent API de Deepgram**, en Node.js con Fastify.
Quien llame a tu número de Twilio habla con un agente de voz que atiende en **español e inglés**:
detecta en qué idioma le hablan y contesta en ese mismo idioma, aunque cambien a mitad de la
llamada.

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

Diagramas más detallados (secuencia completa de una llamada, arquitectura de las herramientas
y estados de una sesión) en [COMO-FUNCIONA.md](COMO-FUNCIONA.md).

## El bilingüismo

Que el agente cambie de idioma bien depende de tres piezas, y las tres tienen que estar de
acuerdo. Es fácil configurar solo una y acabar con un agente que entiende español pero
responde en inglés:

1. **Escuchar** — `flux-general-multi`, el modelo conversacional de Deepgram, con
   `language_hints: ["en", "es"]`. Entiende los turnos de palabra, así que detecta el final de
   frase y las interrupciones bastante mejor que Nova en una llamada.
2. **Pensar** — al prompt se le añade una instrucción explícita de responder en el idioma del
   interlocutor. Sin ella el LLM tiende a contestar en el idioma del prompt de sistema por bien
   que el STT haya transcrito la otra lengua.
3. **Hablar** — aquí está la trampa. Cada voz de Aura-2 está atada a un idioma (el sufijo del
   nombre: `aura-2-thalia-en`). Una voz inglesa dirá una frase en español, pero leyéndola como
   si fuera inglés. **Solo cinco voces alternan los dos idiomas dentro de una misma respuesta**:
   `aura-2-aquila-es`, `aura-2-carina-es`, `aura-2-diana-es`, `aura-2-javier-es` y
   `aura-2-selena-es`. El servidor avisa por log si `SPEAK_MODEL` no es una de ellas — ese aviso
   solo tiene sentido con el proveedor Aura-2, ver nota siguiente.

El proveedor de voz activo en el código ahora mismo es **ElevenLabs** (`eleven_multilingual_v2`),
con `SPEAK_MODEL` como `voice_id`. El bloque Aura-2/Deepgram sigue en
[agent-settings.js](src/agent-settings.js), comentado, para volver a él si hace falta. Las
grabaciones de las cinco voces bilingües de Aura-2 para compararlas sueltas quedan en
`muestras-voces/` (carpeta local, no versionada).

(El campo `agent.language` de la API está deprecado y este proyecto no lo envía.)

## Endpoints

| Ruta      | Método    | Para qué sirve                                                    |
| --------- | --------- | ----------------------------------------------------------------- |
| `/twiml`  | POST, GET | Devuelve el TwiML que abre el Media Stream. Es el webhook de voz. |
| `/twilio` | WebSocket | El puente de audio propiamente dicho.                             |
| `/health` | GET       | Comprobación de vida.                                             |

## Puesta en marcha

```bash
pnpm install
cp .env.example .env   # y rellena DEEPGRAM_API_KEY
pnpm dev
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

## Probar sin hacer una llamada

Hay un simulador que se hace pasar por Twilio: manda los eventos `connected` / `start`, envía
audio a ritmo real y guarda la respuesta del agente en un WAV que puedes escuchar.

```bash
pnpm simulate
```

Sin argumentos manda silencio, así que solo comprueba que llega el saludo. Para probar una
conversación de verdad hace falta una pregunta grabada en mulaw 8 kHz mono:

```bash
ffmpeg -i pregunta.m4a -ar 8000 -ac 1 -f mulaw pregunta.raw
node scripts/simulate-twilio.js --audio pregunta.raw --out respuesta.wav
afplay respuesta.wav
```

| Opción      | Por defecto                  | Qué hace                                                                                                                        |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--url`     | `ws://localhost:5000/twilio` | A dónde conectarse                                                                                                              |
| `--audio`   | *(silencio)*                 | Fichero mulaw 8 kHz que se envía como voz del llamante                                                                          |
| `--delay`   | `6` con audio, `0` sin       | Segundos de silencio antes de hablar, para dejar pasar el saludo. Con `0` la pregunta pisa al agente: así se prueba el barge-in |
| `--seconds` | `25` con audio, `10` sin     | Duración total de la llamada simulada                                                                                           |
| `--out`     | `respuesta-agente.wav`       | Dónde guardar el audio del agente                                                                                               |

Si no tienes nada grabado, el propio TTS de Deepgram sirve para generar las preguntas:

```bash
curl -X POST "https://api.deepgram.com/v1/speak?model=aura-2-javier-es&encoding=mulaw&sample_rate=8000&container=none" \
  -H "Authorization: Token $DEEPGRAM_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"Hola, ¿cuál es el horario de atención al cliente?"}' \
  --output pregunta-es.raw
```

Mientras corre, el log del servidor muestra cada turno con el idioma detectado:

```
[es] user      : Hola, buenos días. ¿Cuál es el horario de atención al cliente?
     assistant : Nuestro horario de atención al cliente es de lunes a viernes, de 9 a 5.
[en] user      : Hi there. What are your customer service hours?
     assistant : Our customer service hours are Monday to Friday, from 9 AM to 5 PM.
```

### Guion de prueba en llamada real

[GUION-PRUEBA.md](GUION-PRUEBA.md) tiene seis turnos pensados para recorrer todo lo que lleva el
PoC en una sola llamada real: encadenado de herramientas, barge-in, fecha relativa, cambio de
idioma a mitad de conversación, dos cadenas combinadas en un turno, y el caso sin herramientas
que de verdad separa a los modelos. Cada turno explica qué mirar en el log del servidor mientras
se prueba, y al final incluye cómo generar los mismos turnos con el TTS de Deepgram para repetir
la prueba igual entre modelos, sin depender de cómo hables.

## Tool calling

El agente lleva cuatro herramientas que forman un "travel concierge" mínimo. No son el
producto: están elegidas porque generan los mismos patrones que después aparecen en ecommerce o
reservas — elegir la herramienta correcta, extraer bien los argumentos, encadenar una llamada
con el resultado de otra, y combinar dos cadenas independientes en una sola respuesta.

| Herramienta          | Fuente               | Por qué está                                    |
| -------------------- | -------------------- | ----------------------------------------------- |
| `resolve_location`   | Open-Meteo Geocoding | Nombre de ciudad → coordenadas. Sin clave       |
| `get_weather`        | Open-Meteo Forecast  | Obliga a encadenar: necesita lat/lon. Sin clave |
| `convert_currency`   | Frankfurter          | Simple y determinista. Sin clave                |
| `get_business_hours` | local, 50–150 ms     | Referencia de latencia sin red de por medio     |

Se declaran sin `endpoint`, así que Deepgram las trata como *client-side*: manda un
`FunctionCallRequest` y las ejecuta este servidor, que responde con `FunctionCallResponse`. Es
lo que permite cronometrarlas. Cuando el modelo pide varias a la vez se ejecutan en paralelo,
porque encadenarlas alargaría el silencio que oye quien llama.

### Relleno hablado mientras corre una tool lenta

`resolve_location` y `get_weather` dependen de una API externa y tardan 200–700 ms; sin nada de
por medio, eso se oye como silencio muerto. Cada tool se declara `fillerEligible: true` o no en
[tools.js](src/tools.js) — lo son esas dos, pero no `convert_currency` (Frankfurter responde en
~90 ms, parecido a la tool local) ni `get_business_hours`. Cuando el modelo pide una tool
`fillerEligible`, el servidor manda un `InjectAgentMessage` (`behavior: "queue"`) con una frase
corta antes de ejecutarla, en el idioma del último turno del usuario. Es un relleno por turno de
usuario, no por `FunctionCallRequest`: si el modelo encadena `resolve_location → get_weather` en
dos rondas, solo la primera lo dispara.

En una llamada real con esas dos herramientas encadenadas, el tiempo hasta el primer audio bajó
de ~3.5 s a ~1.8 s, porque ese primer audio ya es el relleno.

Al prompt se le añade la fecha de hoy: sin ella el modelo no puede resolver "mañana" a una
fecha concreta para `get_weather`, y acaba inventándose una.

En una llamada real el log queda así:

```
[es] user: Hola, ¿qué temperatura hace ahorita en Monterrey?
    ⚙ resolve_location({"query":"Monterrey"}) 654ms ok
    ⚙ get_weather({"latitude":25.68435,"longitude":-100.31721}) 672ms ok
    ⏱ turno: 3507ms
[ - ] assistant: Actualmente en Monterrey, la temperatura es de 33.8 grados y está parcialmente nublado.
```

### Medir y comparar modelos

```bash
pnpm bench                     # todos los modelos configurados
pnpm bench --models a,b        # solo esos
pnpm bench --runs 3            # repite cada caso; las latencias varían
pnpm bench --verbose           # detalle caso por caso
```

El banco llama al LLM **directamente, no a través de la llamada de voz**. Es deliberado: medir
el tool calling a través de TTS→STT mete el ruido del reconocimiento en cada medición, y lo que
se compara aquí es el modelo.

Seis casos con resultado esperado, incluido uno sin herramientas (*"Explícame qué es una
tormenta eléctrica"*) que es el que de verdad separa a los modelos: llamar herramientas de más
es tan caro como no llamarlas.

```
CALIDAD
modelo                       selección  args    cadena   multi   sobran  faltan  paralelo
openai-gpt-4o-mini           100%       100%    100%     100%    0       0       1/6

LATENCIA (mediana, ms)
modelo                       decisión   tool call   externa   continúa   total
openai-gpt-4o-mini           125        126         330       126        707
```

- **selección** — llamó exactamente las herramientas que tocaba
- **args** — los argumentos extraídos son correctos
- **cadena** — `get_weather` recibió las coordenadas que devolvió `resolve_location`, no unas inventadas
- **multi** — aciertos en los casos que necesitan más de una herramienta
- **sobran / faltan** — llamadas innecesarias y ausentes, en total
- **paralelo** — casos en que pidió varias herramientas en el mismo mensaje
- **decisión** — primer token de la respuesta que decide la herramienta
- **tool call** — hasta tener la llamada completa
- **externa** — lo que tardan las herramientas (la más lenta, al ir en paralelo)
- **continúa** — primer token de la respuesta ya con los resultados
- **total** — turno completo

## El LLM: modelos propios en DigitalOcean

El agente usa **DigitalOcean Serverless Inference**, así que lo único que hace falta es la
clave (se crea en la consola, en *Gradient AI → Serverless Inference → Model access keys*):

```env
DIGITALOCEAN_MODEL_ACCESS_KEY=tu_clave
```

Los modelos que se están comparando, con `openai-gpt-4o-mini` como **baseline**:

| Modelo                       | Por qué está en la lista                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai-gpt-4o-mini`         | baseline conocido y estable                                                                                                                |
| `anthropic-claude-haiku-4.5` | mejor apuesta general: calidad + velocidad + tools                                                                                         |
| `openai-gpt-5-nano`          | el más interesante si manda la latencia                                                                                                    |
| `openai-gpt-5.6-luna`        | equilibrio entre capacidad y velocidad                                                                                                     |
| `openai-gpt-5-mini`          | cuánta calidad se gana sacrificando latencia                                                                                               |
| `openai-gpt-oss-20b`         | pesos abiertos: una de las dos excepciones que funcionan hasta en los tiers 1 y 2 de Inference, de repuesto cuando los comerciales dan 403 |

Los modelos comerciales (OpenAI y Anthropic) pueden devolver:

```
HTTP 403: this model is not available for your subscription tier
```

El mensaje es el mismo para dos causas distintas, lo cual despista bastante:

1. **El tier de Serverless Inference.** Sus tiers 1 y 2 excluyen *todo* OpenAI y Anthropic salvo
   `gpt-oss-120b` y `gpt-oss-20b`. Cuidado con esto: es un tier **propio del producto**, se sube
   con su propio prepago, y no tiene que ver con el resource tier que muestra el panel de la
   cuenta — se puede estar en tier 4 de cuenta y seguir en tier 1 de Inference.
2. **El scope de la clave.** Las *model access keys* se scopean al crearlas ("All models" o
   "Select models") y el scope **no se puede editar después**: hay que crear otra.

`pnpm models` las distingue solo: prueba `gpt-oss-120b`, que es la excepción de los tiers bajos.
Si esa pasa y el resto no, es el tier; si no pasa ninguna, es el scope de la clave.

Los modelos de pesos abiertos (Llama, Kimi, Mistral, DeepSeek, gpt-oss) funcionan en ambos casos.

Cuidado con una trampa: `GET /v1/models` devuelve el **catálogo entero** de DigitalOcean, no lo
que tu clave puede usar, así que un modelo puede aparecer listado y aun así dar 403. Por eso
`pnpm models` prueba el acceso de verdad pidiéndole un token a cada modelo de la lista:

```bash
pnpm models            # lista el catálogo y comprueba el acceso real a la shortlist
pnpm models --test     # además pregunta algo al de THINK_MODEL y lo cronometra
```

Para comparar, cambia `THINK_MODEL` y repite la misma pregunta grabada con el simulador: el log
lleva marca de tiempo en cada turno, así que se ve tanto la calidad de la respuesta como lo que
tarda en llegar.

Dos cosas que conviene tener claras: **quien llama al LLM es Deepgram, no este servidor** (el
endpoint tiene que ser accesible desde internet), y por tanto **la clave viaja hasta Deepgram**
dentro del mensaje `Settings` — usa una dedicada y revocable.

Con `THINK_PROVIDER=deepgram` se vuelve al LLM que Deepgram incluye, sin clave propia.

## Configuración

| Variable                        | Por defecto              | Qué controla                                                                                              |
| ------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `AGENT_GREETING`                | *(saludo bilingüe)*      | Lo primero que dice al descolgar                                                                          |
| `AGENT_PROMPT`                  | *(asistente de soporte)* | Instrucciones de sistema (la de idioma se añade sola)                                                     |
| `THINK_PROVIDER`                | `digitalocean`           | `deepgram` para usar el LLM incluido en su lugar                                                          |
| `THINK_MODEL`                   | `openai-gpt-4o-mini`     | Modelo del LLM                                                                                            |
| `THINK_TEMPERATURE`             | `0.7`                    | Temperatura del LLM                                                                                       |
| `DIGITALOCEAN_MODEL_ACCESS_KEY` | *(requerida)*            | Clave de DigitalOcean Serverless Inference                                                                |
| `SPEAK_MODEL`                   | `aura-2-diana-es`        | Voz de síntesis: `voice_id` de ElevenLabs (proveedor activo) o nombre Aura-2 si se vuelve a ese proveedor |

## Estructura

```
GUION-PRUEBA.md               guion manual de seis turnos para probar el PoC en llamada real
COMO-FUNCIONA.md              diagramas: flujo de llamada, arquitectura de tools, estados
src/
├── server.js                  arranque, avisos de configuración y apagado ordenado
├── app.js                     instancia de Fastify y registro de plugins/rutas
├── config.js                  variables de entorno
├── tools.js                   las cuatro herramientas del agente
├── agent-settings.js          mensaje Settings de Deepgram
├── deepgram-agent.js          cliente del Voice Agent (cola, keep-alive, eventos)
└── routes/
    ├── twiml.js               webhook de voz
    └── twilio-stream.js       puente de audio bidireccional
scripts/
├── simulate-twilio.js         cliente de pruebas que imita a Twilio
├── bench-tools.js             banco de pruebas de tool calling
└── list-models.js             lista y prueba los modelos de DigitalOcean
```

## Notas

- El audio se pone en cola mientras la sesión de Deepgram se negocia (`Welcome` → `Settings`),
  así no se pierden los primeros milisegundos de la llamada. Lo mismo al revés: si el saludo
  del agente llega antes que el evento `start` de Twilio, se guarda hasta conocer el `streamSid`.
- Se manda un `KeepAlive` cada 8 s para que Deepgram no cierre la sesión en silencios largos.
- Cerrar cualquiera de los dos extremos cierra el otro.
- El relleno hablado (`InjectAgentMessage`) es audio del agente como cualquier otro: si el
  usuario interrumpe mientras suena, el barge-in lo corta igual que cortaría la respuesta final.
