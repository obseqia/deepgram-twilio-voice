import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';

import { config } from './config.js';
import twimlRoutes from './routes/twiml.js';
import twilioStreamRoutes from './routes/twilio-stream.js';

export async function buildApp(options = {}) {
  const app = Fastify({
    logger: { level: config.logLevel },
    ...options,
  });

  // Twilio postea los webhooks como application/x-www-form-urlencoded.
  await app.register(formbody);
  await app.register(websocket);

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(twimlRoutes);
  await app.register(twilioStreamRoutes);

  return app;
}
