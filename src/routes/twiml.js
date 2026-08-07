import { config } from '../config.js';

/**
 * Devuelve el TwiML que le dice a Twilio que abra un Media Stream bidireccional
 * contra nuestro websocket. Apunta el webhook de voz del número aquí y te
 * ahorras mantener un TwiML Bin con la URL de ngrok a mano.
 */
export default async function twimlRoutes(fastify) {
  const handler = async (request, reply) => {
    const wsUrl = config.publicWsUrl ?? `wss://${request.headers.host}/twilio`;

    request.log.info({ wsUrl }, 'TwiML solicitado');

    reply
      .type('text/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<Response>\n` +
          `  <Connect>\n` +
          `    <Stream url="${wsUrl}" />\n` +
          `  </Connect>\n` +
          `</Response>\n`,
      );
  };

  // Twilio usa POST por defecto; GET queda disponible para probar en el navegador.
  fastify.post('/twiml', handler);
  fastify.get('/twiml', handler);
}
