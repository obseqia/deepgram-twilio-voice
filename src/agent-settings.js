import { config } from './config.js';

/**
 * El agente atiende en español e inglés, y cambia de uno a otro según le hablen.
 * Eso depende de tres piezas que tienen que estar de acuerdo:
 *
 *   1. escuchar → `flux-general-multi`, el modelo conversacional de Deepgram,
 *      con hints para los dos idiomas;
 *   2. pensar   → una instrucción explícita al LLM, porque si no tiende a
 *      responder siempre en el idioma del prompt de sistema;
 *   3. hablar   → una voz que sepa alternar los dos (ver BILINGUAL_VOICES).
 */
const LANGUAGE_DIRECTIVE =
  '\n\nYou are bilingual in English and Spanish. Always reply in the same language ' +
  'the caller is using, and switch as soon as they do, even mid-conversation. Never ' +
  'announce or comment on the language change, and never translate your own answer ' +
  'into the other language.';

/**
 * Construye el mensaje `Settings` que inicializa la sesión del Voice Agent.
 *
 * El audio va en mulaw a 8 kHz en ambos sentidos: es exactamente el formato que
 * usa Twilio en sus Media Streams, así que no hace falta transcodificar nada.
 *
 * Nota: `agent.language` está deprecado y no se envía; el idioma se configura
 * por proveedor (`language_hints` al escuchar, voz bilingüe al hablar).
 */
export function buildSettings() {
  const { agent } = config;

  const think = {
    provider: {
      type: 'open_ai',
      model: agent.thinkModel,
      temperature: agent.thinkTemperature,
    },
    prompt: agent.prompt + LANGUAGE_DIRECTIVE,
  };

  // Con un endpoint propio Deepgram solo le hace de cliente: le manda la
  // conversación en formato OpenAI y espera la respuesta en streaming.
  if (agent.thinkEndpointUrl) {
    think.endpoint = {
      url: agent.thinkEndpointUrl,
      headers: { authorization: `Bearer ${agent.thinkApiKey}` },
    };
  }

  return {
    type: 'Settings',
    audio: {
      input: {
        encoding: 'mulaw',
        sample_rate: 8000,
      },
      output: {
        encoding: 'mulaw',
        sample_rate: 8000,
        container: 'none',
      },
    },
    agent: {
      listen: {
        provider: {
          type: 'deepgram',
          model: 'flux-general-multi',
          version: 'v2',
          language_hints: ['en', 'es'],
        },
      },
      think,
      speak: {
        provider: {
          type: 'deepgram',
          model: agent.speakModel,
        },
      },
      greeting: agent.greeting,
    },
  };
}
