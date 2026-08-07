/**
 * Simula un Media Stream de Twilio para probar el puente sin hacer una llamada.
 *
 *   node scripts/simulate-twilio.js [ws://localhost:5000/twilio] [segundos]
 *
 * Envía los eventos `connected` / `start` y luego silencio en mulaw a ritmo real
 * (una trama de 160 bytes cada 20 ms), e informa del audio que devuelve el
 * agente. Si todo funciona verás llegar el saludo en pocos segundos.
 */
import WebSocket from 'ws';

const url = process.argv[2] ?? 'ws://localhost:5000/twilio';
const seconds = Number(process.argv[3] ?? 10);

const FRAME_BYTES = 160; // 20 ms de mulaw a 8 kHz
const SILENCE = Buffer.alloc(FRAME_BYTES, 0xff); // 0xFF es el cero del mulaw
const streamSid = `MZ${Date.now().toString(16).padStart(30, '0')}`.slice(0, 34);

const ws = new WebSocket(url);

let framesReceived = 0;
let bytesReceived = 0;

ws.on('open', () => {
  console.log(`Conectado a ${url}`);

  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(
    JSON.stringify({
      event: 'start',
      sequenceNumber: '1',
      streamSid,
      start: {
        streamSid,
        accountSid: 'ACsimulated',
        callSid: 'CAsimulated',
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    }),
  );

  let sequence = 2;
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(timer);
    ws.send(
      JSON.stringify({
        event: 'media',
        sequenceNumber: String(sequence++),
        streamSid,
        media: {
          track: 'inbound',
          chunk: String(sequence),
          timestamp: String(sequence * 20),
          payload: SILENCE.toString('base64'),
        },
      }),
    );
  }, 20);

  setTimeout(() => {
    clearInterval(timer);
    ws.send(JSON.stringify({ event: 'stop', streamSid, stop: { callSid: 'CAsimulated' } }));
    ws.close();
  }, seconds * 1000);
});

ws.on('message', (raw) => {
  const data = JSON.parse(raw.toString());
  if (data.event === 'media') {
    framesReceived += 1;
    bytesReceived += Buffer.from(data.media.payload, 'base64').length;
    if (framesReceived === 1) console.log('Primer audio del agente recibido');
    return;
  }
  console.log('Evento recibido:', data.event);
});

ws.on('close', () => {
  const ms = Math.round((bytesReceived / 8000) * 1000);
  console.log(
    `\nCerrado. ${framesReceived} mensajes de audio, ${bytesReceived} bytes (~${ms} ms de voz).`,
  );
  console.log(
    framesReceived > 0
      ? 'OK: el agente respondió.'
      : 'Sin audio del agente: revisa DEEPGRAM_API_KEY y los logs del servidor.',
  );
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
