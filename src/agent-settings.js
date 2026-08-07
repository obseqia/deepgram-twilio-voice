import { config } from './config.js';

/**
 * Construye el mensaje `Settings` que inicializa la sesión del Voice Agent.
 *
 * El audio va en mulaw a 8 kHz en ambos sentidos: es exactamente el formato que
 * usa Twilio en sus Media Streams, así que no hace falta transcodificar nada.
 */
export function buildSettings(overrides = {}) {
  const agent = { ...config.agent, ...overrides };

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
      language: agent.language,
      listen: {
        provider: {
          type: 'deepgram',
          model: agent.listenModel,
        },
      },
      think: {
        provider: {
          type: agent.thinkProvider,
          model: agent.thinkModel,
          temperature: agent.thinkTemperature,
        },
        prompt: agent.prompt,
      },
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
