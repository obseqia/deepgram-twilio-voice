# Guion de prueba

Seis turnos que recorren todo lo que lleva el PoC. El orden no es casual: cada turno deja el
terreno puesto para el siguiente, y los cambios de idioma caen donde más incómodos son para el
modelo (a mitad de conversación, con contexto acumulado).

Ten el log del servidor a la vista mientras llamas: la mitad de lo que se prueba aquí no se oye,
se lee.

## Antes de llamar

```bash
pnpm dev          # y en otra terminal:
ngrok http 5000
```

---

## Turno 0 · El agente saluda

No dices nada, solo escuchas.

> **Agente:** Hello! ¿En qué puedo ayudarte? How can I help you today?

**Qué se prueba:** que el saludo bilingüe suene natural en los dos idiomas con la misma voz.
Si el "Hello" suena a español mal pronunciado o el "¿En qué puedo ayudarte?" suena a inglés,
`SPEAK_MODEL` no es una de las cinco voces con code-switching.

---

## Turno 1 · Encadenar dos herramientas (ES)

> **Tú:** «Hola, buenas tardes. ¿Qué temperatura hace ahorita en Monterrey?»

**Qué se prueba:** encadenado. El modelo no puede llamar a `get_weather` directamente porque
necesita coordenadas, así que tiene que pasar primero por `resolve_location` y usar su
resultado.

**En el log:**

```
[es] user: Hola, buenas tardes. ¿Qué temperatura hace ahorita en Monterrey?
    ⚙ resolve_location({"query":"Monterrey"}) 654ms ok
    ⚙ get_weather({"latitude":25.68435,"longitude":-100.31721}) 672ms ok
    ⏱ turno: 3507ms
```

Fíjate en que las coordenadas de `get_weather` son las que devolvió `resolve_location`. Si
salen coordenadas redondas o distintas, se las está inventando.

---

## Turno 2 · Interrumpirle (barge-in)

Espera a que empiece a decirte la temperatura y **córtale a media frase**, sin dejarle acabar:

> **Tú:** «Perdón, perdón… mejor dime cómo va a estar mañana.»

**Qué se prueba:** el barge-in. Su voz tiene que cortarse **en seco**, no seguir sonando unos
segundos. Y además una fecha relativa: "mañana" solo se puede resolver porque el prompt lleva
la fecha de hoy.

**En el log:**

```
Barge-in: se limpia el audio pendiente
[es] user: mejor dime cómo va a estar mañana
    ⚙ get_weather({"latitude":25.68435,"longitude":-100.31721,"date":"2026-08-15"}) 169ms ok
```

Dos cosas que confirmar aquí: que el `date` es la fecha de mañana de verdad, y que **no** volvió
a llamar a `resolve_location` — ya sabía las coordenadas de Monterrey por el turno anterior.

---

## Turno 3 · La herramienta local (ES)

> **Tú:** «Ah, y ¿a qué hora abren ustedes el sábado?»

**Qué se prueba:** `get_business_hours`, la única herramienta sin red de por medio. Sirve de
referencia: si el turno completo sigue tardando segundos con una herramienta de 50–150 ms, el
tiempo se va en el LLM, no en las APIs externas.

**En el log:**

```
    ⚙ get_business_hours({"day":"saturday"}) 136ms ok
    ⏱ turno: 968ms
```

Debe contestar 10:00–14:00, que es distinto del horario de semana. Si dice 9:00–18:00, no llamó
a la herramienta y se lo inventó.

---

## Turno 4 · Cambio de idioma y dos cadenas a la vez (EN)

Aquí está el turno duro. Cambia a inglés de golpe y pide dos cosas sin relación entre sí:

> **Tú:** «Actually, let me switch to English. I'm flying to Austin tomorrow — what's the weather
> going to be like, and how much is 250 dollars in Mexican pesos?»

**Qué se prueba:** cuatro cosas de una vez — que detecta el cambio de idioma y **responde en
inglés sin comentar el cambio**; que arranca una cadena nueva (`resolve_location` de Austin,
no de Monterrey); que mantiene la fecha relativa; y que combina dos cadenas independientes en
una sola respuesta.

**En el log:**

```
[en] user: Actually, let me switch to English. I'm flying to Austin tomorrow — ...
    ⚙ resolve_location({"query":"Austin"}) 210ms ok
    ⚙ convert_currency({"amount":250,"from":"USD","to":"MXN"}) 85ms ok
    ⚙ get_weather({"latitude":30.27,"longitude":-97.74,"date":"2026-08-15"}) 180ms ok
```

Si `resolve_location` y `convert_currency` aparecen con tiempos solapados, las pidió en paralelo
—lo ideal, porque el turno cuesta lo que la más lenta y no la suma.

Y comprueba que **no** traduce su propia respuesta al español ni anuncia "sure, switching to
English": el prompt se lo prohíbe explícitamente.

---

## Turno 5 · Que NO llame a nada (EN)

> **Tú:** «Thanks. Out of curiosity, what exactly is a thunderstorm?»

**Qué se prueba:** el más importante de todos. Es conocimiento general: **no debe aparecer
ninguna línea `⚙` en el log**. Llamar herramientas de más cuesta lo mismo que no llamarlas
cuando toca: latencia que el usuario oye como silencio.

Ojo con el falso positivo tentador: tiene `get_weather` a mano y la palabra "thunderstorm" está
en el vocabulario de condiciones meteorológicas.

---

## Turno 6 · Vuelta al español con contexto (ES)

> **Tú:** «Oye, una última cosa: ¿y cuántos pesos serían 80 dólares?»

**Qué se prueba:** que vuelve al español igual de limpio, y que arrastra el contexto — la frase
no dice "mexicanos" ni "USD", así que las divisas tiene que sacarlas del turno 4.

**En el log:**

```
[es] user: una última cosa, ¿y cuántos pesos serían 80 dólares?
    ⚙ convert_currency({"amount":80,"from":"USD","to":"MXN"}) 89ms ok
```

---

## Repaso

| Feature                                   | Turno |
| ----------------------------------------- | ----- |
| Saludo bilingüe con voz code-switching    | 0     |
| Encadenado `resolve_location → get_weather` | 1   |
| Barge-in                                  | 2     |
| Fecha relativa ("mañana")                 | 2, 4  |
| Reutilizar coordenadas ya resueltas       | 2     |
| Herramienta local `get_business_hours`    | 3     |
| Cambio es → en a mitad de llamada         | 4     |
| Dos cadenas combinadas en un turno        | 4     |
| Llamadas en paralelo                      | 4     |
| `convert_currency`                        | 4, 6  |
| Ninguna herramienta cuando no toca        | 5     |
| Cambio en → es y contexto arrastrado      | 6     |
| Latencia por turno                        | todos |

## La misma prueba, sin llamar

Para repetirla igual entre modelos conviene que no dependa de cómo hables. Genera los turnos con
el propio TTS de Deepgram y pásalos al simulador:

```bash
KEY=$(grep DEEPGRAM_API_KEY .env | cut -d= -f2)

curl -s -X POST "https://api.deepgram.com/v1/speak?model=aura-2-javier-es&encoding=mulaw&sample_rate=8000&container=none" \
  -H "Authorization: Token $KEY" -H "Content-Type: application/json" \
  -d '{"text":"Hola, buenas tardes. ¿Qué temperatura hace ahorita en Monterrey?"}' \
  --output t1.raw

curl -s -X POST "https://api.deepgram.com/v1/speak?model=aura-2-orion-en&encoding=mulaw&sample_rate=8000&container=none" \
  -H "Authorization: Token $KEY" -H "Content-Type: application/json" \
  -d '{"text":"Actually, let me switch to English. I am flying to Austin tomorrow. What is the weather going to be like, and how much is 250 dollars in Mexican pesos?"}' \
  --output t4.raw

# Un turno tras otro, con silencio en medio para que le dé tiempo a contestar
node -e "const f=require('fs');f.writeFileSync('guion.raw',Buffer.concat([f.readFileSync('t1.raw'),Buffer.alloc(8000*12,0xff),f.readFileSync('t4.raw')]))"

node scripts/simulate-twilio.js --audio guion.raw --seconds 60 --out respuesta.wav
afplay respuesta.wav
```

Para probar el barge-in por esta vía, `--delay 0`: la pregunta empieza encima del saludo.
