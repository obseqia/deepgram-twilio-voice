import WebSocket from 'ws';

import { config } from '../config.js';
import { DeepgramAgent } from '../deepgram-agent.js';

/**
 * Puente bidireccional entre un Media Stream de Twilio y el Voice Agent de
 * Deepgram. Ambos extremos hablan mulaw a 8 kHz, así que el audio se reenvía
 * tal cual: solo cambia el envoltorio (base64 dentro de JSON en el lado Twilio,
 * frames binarios en el lado Deepgram).
 */
export default async function twilioStreamRoutes(fastify) {
  fastify.get('/twilio', { websocket: true }, (socket, request) => {
    const log = request.log;
    log.info('Twilio abrió el media stream');

    let streamSid = null;
    let inbuffer = Buffer.alloc(0);
    // Mensajes para Twilio generados antes de conocer el streamSid (el saludo
    // del agente puede llegar antes que el evento `start`).
    let outboundQueue = [];

    const agent = new DeepgramAgent().connect();

    const sendToTwilio = (payload) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(payload));
    };

    const emitMedia = (mulaw) => {
      if (!streamSid) {
        outboundQueue.push(mulaw);
        return;
      }
      sendToTwilio({
        event: 'media',
        streamSid,
        media: { payload: mulaw.toString('base64') },
      });
    };

    const drainOutbound = () => {
      const queued = outboundQueue;
      outboundQueue = [];
      for (const mulaw of queued) emitMedia(mulaw);
    };

    // --- Deepgram -> Twilio -------------------------------------------------

    agent.on('ready', () => log.info('Sesión de Deepgram configurada'));

    agent.on('audio', emitMedia);

    agent.on('userStartedSpeaking', () => {
      // Barge-in: el usuario habla encima del agente, así que descartamos el
      // audio que Twilio aún tenga en su búfer de reproducción.
      log.info('Barge-in: se limpia el audio pendiente');
      outboundQueue = [];
      if (streamSid) sendToTwilio({ event: 'clear', streamSid });
    });

    agent.on('event', (message) => {
      if (message.type === 'ConversationText') {
        log.info({ role: message.role, content: message.content }, 'conversación');
      } else {
        log.debug({ message }, 'evento de Deepgram');
      }
    });

    agent.on('error', (err) => log.error({ err }, 'error de Deepgram'));

    agent.on('close', (code, reason) => {
      log.info({ code, reason }, 'Deepgram cerró la conexión');
      if (socket.readyState === WebSocket.OPEN) socket.close();
    });

    // --- Twilio -> Deepgram -------------------------------------------------

    socket.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch (err) {
        log.warn({ err }, 'mensaje de Twilio ilegible');
        return;
      }

      switch (data.event) {
        case 'connected':
          break;

        case 'start':
          streamSid = data.start.streamSid;
          log.info({ streamSid, callSid: data.start.callSid }, 'llamada iniciada');
          drainOutbound();
          break;

        case 'media':
          if (data.media.track !== 'inbound') break;
          inbuffer = Buffer.concat([inbuffer, Buffer.from(data.media.payload, 'base64')]);
          while (inbuffer.length >= config.audio.chunkBytes) {
            agent.sendAudio(inbuffer.subarray(0, config.audio.chunkBytes));
            inbuffer = inbuffer.subarray(config.audio.chunkBytes);
          }
          break;

        case 'stop':
          log.info('Twilio envió stop');
          agent.close();
          break;

        default:
          break;
      }
    });

    socket.on('close', () => {
      log.info('Twilio cerró el media stream');
      agent.close();
    });

    socket.on('error', (err) => {
      log.error({ err }, 'error en el socket de Twilio');
      agent.close();
    });
  });
}
