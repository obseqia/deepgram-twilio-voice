import { buildApp } from './app.js';
import { config, assertConfig, BILINGUAL_VOICES } from './config.js';

assertConfig();

const app = await buildApp();

if (!BILINGUAL_VOICES.includes(config.agent.speakModel)) {
  app.log.warn(
    `La voz ${config.agent.speakModel} no alterna español e inglés: leerá uno de los dos ` +
      `con la fonética equivocada. Voces que sí lo hacen: ${BILINGUAL_VOICES.join(', ')}`,
  );
}

app.log.info(
  {
    model: config.agent.thinkModel,
    endpoint: config.agent.thinkEndpointUrl ?? 'el LLM incluido en Deepgram',
  },
  'LLM del agente',
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.log.info(`${signal} recibido, cerrando`);
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Websocket para Twilio en ws://${config.host}:${config.port}/twilio`);
  app.log.info(`TwiML en http://${config.host}:${config.port}/twiml`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
