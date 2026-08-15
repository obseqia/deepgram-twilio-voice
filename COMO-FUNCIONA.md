# Cómo funciona

Diagramas de referencia para quien vaya a tocar el código: el flujo de una llamada de
principio a fin, la arquitectura de las herramientas del agente, y los estados por los que
pasa una sesión. Para la vista general del proyecto, ver el [README](README.md).

## Flujo de una llamada

```mermaid
sequenceDiagram
    autonumber
    actor Persona as Persona que llama
    participant Twilio
    participant Servidor as Servidor (Fastify)
    participant Agente as DeepgramAgent
    participant Deepgram as Deepgram Voice Agent API

    Persona->>Twilio: Marca el número
    Twilio->>Servidor: POST /twiml
    Servidor-->>Twilio: TwiML <Connect><Stream url="wss://.../twilio">
    Twilio->>Servidor: Abre WS /twilio
    Servidor->>Agente: new DeepgramAgent().connect()
    Agente->>Deepgram: Abre WS wss://agent.deepgram.com/v1/agent/converse
    Deepgram-->>Agente: Welcome
    Agente->>Deepgram: Settings (buildSettings())
    Agente-->>Servidor: ready
    Twilio->>Servidor: event: start (streamSid)
    Servidor->>Servidor: drena outboundQueue (audio en cola)

    loop mientras dura la llamada
        Twilio->>Servidor: event: media (mulaw b64)
        Servidor->>Agente: sendAudio() (bloques de 400 ms)
        Agente->>Deepgram: frame binario mulaw
        Deepgram-->>Agente: frame binario mulaw (respuesta hablada)
        Agente-->>Servidor: audio (Buffer)
        Servidor-->>Twilio: event: media (mulaw b64)
    end

    opt el modelo pide una herramienta
        Deepgram-->>Agente: FunctionCallRequest
        opt tool marcada fillerEligible
            Agente->>Deepgram: InjectAgentMessage (frase de relleno)
        end
        Agente->>Agente: runTool(name, args) [tools.js]
        Agente->>Deepgram: FunctionCallResponse
    end

    opt barge-in
        Deepgram-->>Agente: UserStartedSpeaking
        Agente-->>Servidor: userStartedSpeaking
        Servidor->>Twilio: event: clear (descarta audio en búfer)
    end

    Twilio->>Servidor: event: stop
    Servidor->>Agente: close()
    Agente->>Deepgram: cierra WS (1000)
    Servidor->>Twilio: cierra WS /twilio
```

Notas sobre el diagrama:

- El audio se reenvía tal cual entre Twilio y Deepgram: ambos hablan mulaw a 8 kHz, así que
  solo cambia el envoltorio (base64 dentro de JSON en el lado Twilio, frames binarios en el
  lado Deepgram). Ver [twilio-stream.js](src/routes/twilio-stream.js).
- El audio entrante se agrupa en bloques de 400 ms antes de mandarlo a Deepgram
  (`config.audio.chunkBytes`), para no hacer una escritura de socket cada 20 ms.
- El relleno hablado (`InjectAgentMessage`) solo se envía para tools marcadas
  `fillerEligible: true` en [tools.js](src/tools.js) — ver la sección
  ["Tool calling"](README.md#tool-calling) del README.
- El barge-in (`UserStartedSpeaking` → `clear`) descarta el audio que Twilio tenga en su
  búfer de reproducción, para que la persona pueda interrumpir al agente hablándole encima.
- El audio se pone en cola mientras la sesión de Deepgram se negocia (`Welcome` → `Settings`),
  y lo mismo al revés si el saludo del agente llega antes que el evento `start` de Twilio (no
  se conoce el `streamSid` todavía). Así no se pierden los primeros milisegundos de la llamada.

## Arquitectura de src/tools.js

```mermaid
flowchart TD
    subgraph tools_js ["src/tools.js"]
        TOOLS[["TOOLS[] — 4 definiciones
name · description · parameters · run() · fillerEligible?"]]
        RL[resolve_location]
        GW[get_weather]
        CC[convert_currency]
        BH[get_business_hours]
        TOOLS --> RL & GW & CC & BH

        runTool(("runTool(name, args)
cronometra, nunca lanza"))
        anyNeedsFiller(("anyNeedsFiller(names)"))
        deepgramFunctions(("deepgramFunctions()
formato Settings de Deepgram"))
        openAiTools(("openAiTools()
formato tools de OpenAI"))

        TOOLS -.-> runTool
        TOOLS -.-> anyNeedsFiller
        TOOLS -.-> deepgramFunctions
        TOOLS -.-> openAiTools
    end

    RL -->|fetch| GEO[Open-Meteo Geocoding API]
    GW -->|fetch| FORECAST[Open-Meteo Forecast API]
    CC -->|fetch| FRANK[Frankfurter API]
    BH -->|setTimeout 50-150ms| LOCAL[(horario en memoria)]

    AS["agent-settings.js
buildSettings()"] -->|usa| deepgramFunctions
    DA["deepgram-agent.js
DeepgramAgent"] -->|usa| runTool
    DA -->|usa| anyNeedsFiller
    BENCH[scripts/bench-tools.js] -->|usa| openAiTools
    BENCH -->|usa| runTool
    BENCH -->|usa| TOOLS
```

`tools.js` es el único punto de contacto entre el agente y el mundo exterior. Expone cuatro
funciones sobre el mismo array `TOOLS`:

- `deepgramFunctions()` — formatea las definiciones para el mensaje `Settings` que arma
  [agent-settings.js](src/agent-settings.js).
- `runTool(name, args)` — ejecuta una herramienta y cronometra cuánto tarda; nunca lanza, así
  un fallo de la API externa se devuelve como resultado para que el modelo se lo explique a
  quien llama en vez de cortar la llamada.
- `anyNeedsFiller(names)` — decide si toca mandar una frase de relleno antes de ejecutar
  (usado por [deepgram-agent.js](src/deepgram-agent.js)).
- `openAiTools()` — la misma lista en formato de tools de OpenAI, para que
  [bench-tools.js](scripts/bench-tools.js) pueda comparar modelos llamando al LLM
  directamente, sin pasar por una llamada de voz real.

## Estados de una sesión

```mermaid
stateDiagram-v2
    [*] --> Conectando: Twilio abre WS /twilio → new DeepgramAgent().connect()

    Conectando --> Lista: Welcome de Deepgram → Settings enviados → 'ready'
    Conectando --> Cerrada: error de conexión

    Lista --> Escuchando: evento start de Twilio (streamSid conocido, cola drenada)

    state Escuchando {
        [*] --> Idle
        Idle --> UsuarioHablando: UserStartedSpeaking
        UsuarioHablando --> Idle: clear enviado a Twilio (barge-in)
        Idle --> EjecutandoTool: FunctionCallRequest
        EjecutandoTool --> Idle: FunctionCallResponse enviado
    }

    Escuchando --> Cerrada: stop de Twilio / close de Deepgram / error de socket
    Cerrada --> [*]
```

`UsuarioHablando` es una simplificación: Deepgram manda `UserStartedSpeaking` cuando detecta
que la persona empezó a hablar encima del agente, pero no hay un evento equivalente de "dejó
de hablar" — la sesión vuelve a `Idle` sin una transición explícita en el código. En el
diagrama es más una anotación de intención que un estado 1:1 con lo que hace
[deepgram-agent.js](src/deepgram-agent.js).
