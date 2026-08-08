import { validateVoice } from './voices.js';

// Carga .env sin dependencias externas (Node >= 20.6).
try {
  process.loadEnvFile();
} catch {
  // No hay .env: se usan las variables ya presentes en el entorno.
}

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value, fallback) => {
  const parsed = (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? [...new Set(parsed)] : fallback;
};

/** Endpoint de inferencia serverless de DigitalOcean, compatible con OpenAI. */
export const DIGITALOCEAN_INFERENCE_URL = 'https://inference.do-ai.run/v1';

/**
 * Resuelve qué LLM usa el agente.
 *
 * Deepgram acepta cualquier servicio compatible con OpenAI: se declara el
 * proveedor como `open_ai` y se le pasa la URL y la cabecera de autorización en
 * `think.endpoint`. Quien llama al LLM es Deepgram, no este servidor, así que el
 * endpoint tiene que ser accesible desde internet y la clave viaja hasta ellos
 * dentro del mensaje `Settings`.
 *
 * `THINK_PROVIDER=digitalocean` es un atajo para no repetir la URL.
 */
function think() {
  const provider = (process.env.THINK_PROVIDER ?? 'open_ai').toLowerCase();
  const isDigitalOcean = provider === 'digitalocean' || provider === 'do';

  const endpointUrl =
    process.env.THINK_ENDPOINT_URL ||
    (isDigitalOcean ? `${DIGITALOCEAN_INFERENCE_URL}/chat/completions` : null);

  const apiKey = isDigitalOcean
    ? process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
    : process.env.THINK_API_KEY;

  return {
    // Un endpoint propio compatible con OpenAI se declara siempre como `open_ai`.
    thinkProvider: isDigitalOcean ? 'open_ai' : provider,
    thinkModel:
      process.env.THINK_MODEL ?? (isDigitalOcean ? 'llama3.3-70b-instruct' : 'gpt-4o-mini'),
    thinkTemperature: num(process.env.THINK_TEMPERATURE, 0.7),
    thinkEndpointUrl: endpointUrl,
    thinkApiKey: apiKey || null,
    thinkIsDigitalOcean: isDigitalOcean,
  };
}

export const config = {
  port: num(process.env.PORT, 5000),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY,
    agentUrl: process.env.DEEPGRAM_AGENT_URL ?? 'wss://agent.deepgram.com/v1/agent/converse',
  },

  // Si está vacía, /twiml deriva la URL del header Host de la petición entrante.
  publicWsUrl: process.env.PUBLIC_WS_URL || null,

  agent: {
    // Idiomas que el agente entiende y habla, en orden de preferencia.
    languages: list(process.env.AGENT_LANGUAGES, ['en', 'es']),
    greeting:
      process.env.AGENT_GREETING ?? 'Hello! ¿En qué puedo ayudarte? How can I help you today?',
    prompt:
      process.env.AGENT_PROMPT ??
      'You are a helpful AI assistant focused on customer service. Keep your answers short and conversational, you are speaking over the phone.',
    // Vacío = se elige según los idiomas (ver src/agent-settings.js).
    listenModel: process.env.LISTEN_MODEL || null,
    ...think(),
    // Voz española con code-switching es/en (ver src/voices.js).
    speakModel: process.env.SPEAK_MODEL ?? 'aura-2-diana-es',
  },

  // Twilio envía tramas de 160 bytes (20 ms de mulaw a 8 kHz). Agrupamos 20 de
  // ellas (400 ms) antes de reenviarlas a Deepgram para reducir el número de
  // escrituras en el socket.
  audio: {
    twilioFrameBytes: 160,
    framesPerChunk: 20,
    get chunkBytes() {
      return this.twilioFrameBytes * this.framesPerChunk;
    },
  },
};

export function assertConfig() {
  if (!config.deepgram.apiKey) {
    throw new Error(
      'Falta DEEPGRAM_API_KEY. Copia .env.example a .env y rellena la clave, ' +
        'o expórtala en el entorno.',
    );
  }
  if (config.agent.languages.length === 0) {
    throw new Error('AGENT_LANGUAGES no puede estar vacío.');
  }
  if (config.agent.thinkIsDigitalOcean && !config.agent.thinkApiKey) {
    throw new Error(
      'THINK_PROVIDER=digitalocean requiere DIGITALOCEAN_MODEL_ACCESS_KEY. ' +
        'Créala en la consola de DigitalOcean, en Gradient AI → Serverless Inference.',
    );
  }
  if (config.agent.thinkEndpointUrl && !config.agent.thinkApiKey) {
    throw new Error(
      'Hay THINK_ENDPOINT_URL pero no THINK_API_KEY: el endpoint quedaría sin autorización.',
    );
  }
}

/**
 * Avisa si la voz elegida no cubre bien los idiomas configurados. No aborta el
 * arranque: la llamada funcionaría igual, solo que sonando mal, y eso es una
 * decisión del que despliega.
 */
export function checkVoice(log) {
  const result = validateVoice(config.agent.speakModel, config.agent.languages);
  const detail = { voice: config.agent.speakModel, languages: config.agent.languages };

  if (result.ok) {
    log.info(detail, result.message);
    return result;
  }

  log.warn(detail, result.message);
  if (result.suggestions?.length) {
    log.warn(`Voces que sí lo hacen: ${result.suggestions.join(' · ')}`);
  }
  return result;
}
