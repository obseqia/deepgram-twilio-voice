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
    language: process.env.AGENT_LANGUAGE ?? 'en',
    greeting: process.env.AGENT_GREETING ?? 'Hello! How can I help you today?',
    prompt:
      process.env.AGENT_PROMPT ??
      'You are a helpful AI assistant focused on customer service. Keep your answers short and conversational, you are speaking over the phone.',
    listenModel: process.env.LISTEN_MODEL ?? 'nova-3',
    thinkProvider: process.env.THINK_PROVIDER ?? 'open_ai',
    thinkModel: process.env.THINK_MODEL ?? 'gpt-4o-mini',
    thinkTemperature: num(process.env.THINK_TEMPERATURE, 0.7),
    speakModel: process.env.SPEAK_MODEL ?? 'aura-2-thalia-en',
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
}
