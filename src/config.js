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

/** Endpoint de inferencia serverless de DigitalOcean, compatible con OpenAI. */
export const DIGITALOCEAN_INFERENCE_URL = 'https://inference.do-ai.run/v1';

/**
 * Únicas voces de Aura-2 que alternan español e inglés dentro de una misma
 * respuesta. Las demás dirán el otro idioma con la fonética equivocada.
 */
export const BILINGUAL_VOICES = [
  'aura-2-aquila-es',
  'aura-2-carina-es',
  'aura-2-diana-es',
  'aura-2-javier-es',
  'aura-2-selena-es',
];

/**
 * Modelos de DigitalOcean con los que se está probando este agente.
 * `openai-gpt-4o-mini` es el baseline contra el que se comparan los demás.
 */
export const DIGITALOCEAN_MODELS = [
  'openai-gpt-4o-mini',
  'anthropic-claude-haiku-4.5',
  'openai-gpt-5.6-luna',
  'mimo-v2.5',
];

const useDigitalOcean =
  (process.env.THINK_PROVIDER ?? 'digitalocean').toLowerCase() === 'digitalocean';

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
    greeting:
      process.env.AGENT_GREETING ?? 'Hello! ¿En qué puedo ayudarte? How can I help you today?',
    prompt:
      process.env.AGENT_PROMPT ??
      'You are a helpful AI assistant focused on customer service. Keep your answers short and conversational, you are speaking over the phone.',
    thinkModel: process.env.THINK_MODEL ?? (useDigitalOcean ? DIGITALOCEAN_MODELS[0] : 'gpt-4o-mini'),
    thinkTemperature: num(process.env.THINK_TEMPERATURE, 0.7),
    // Vacío = el LLM que incluye Deepgram.
    thinkEndpointUrl: useDigitalOcean ? `${DIGITALOCEAN_INFERENCE_URL}/chat/completions` : null,
    thinkApiKey: process.env.DIGITALOCEAN_MODEL_ACCESS_KEY || null,
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
  if (config.agent.thinkEndpointUrl && !config.agent.thinkApiKey) {
    throw new Error(
      'THINK_PROVIDER=digitalocean requiere DIGITALOCEAN_MODEL_ACCESS_KEY. ' +
        'Créala en la consola de DigitalOcean, en Gradient AI → Serverless Inference.',
    );
  }
}
