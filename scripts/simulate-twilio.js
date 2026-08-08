/**
 * Simula un Media Stream de Twilio para probar el puente sin hacer una llamada.
 *
 *   node scripts/simulate-twilio.js [--url ws://localhost:5000/twilio]
 *                                   [--audio pregunta.raw] [--seconds 20]
 *                                   [--out respuesta.wav]
 *
 * Envía los eventos `connected` / `start` y luego audio a ritmo real (una trama
 * de 160 bytes cada 20 ms): el contenido de `--audio` si se indica, o silencio.
 * El audio que devuelve el agente se guarda como WAV para poder escucharlo.
 *
 * Para preparar una pregunta grabada, en mulaw 8 kHz mono:
 *   ffmpeg -i pregunta.m4a -ar 8000 -ac 1 -f mulaw pregunta.raw
 */
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const flag = (flagName, fallback) => {
  const index = args.indexOf(flagName);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const url = flag('--url', 'ws://localhost:5000/twilio');
const audioPath = flag('--audio', null);
const outPath = flag('--out', 'respuesta-agente.wav');
const seconds = Number(flag('--seconds', audioPath ? 25 : 10));
// Silencio antes de empezar a "hablar", para dejar que termine el saludo. Con
// 0 la pregunta pisa al agente, que es justo como se prueba el barge-in.
const delaySeconds = Number(flag('--delay', audioPath ? 6 : 0));

const FRAME_BYTES = 160; // 20 ms de mulaw a 8 kHz
const SAMPLE_RATE = 8000;
const SILENCE = Buffer.alloc(FRAME_BYTES, 0xff); // 0xFF es el cero del mulaw
const streamSid = `MZ${Date.now().toString(16)}`.padEnd(34, '0').slice(0, 34);

const source = audioPath ? readFileSync(audioPath) : null;
if (source) {
  const ms = Math.round((source.length / SAMPLE_RATE) * 1000);
  console.log(`Audio de entrada: ${audioPath} (${source.length} bytes, ~${ms} ms)`);
} else {
  console.log('Sin --audio: se envía silencio (solo se comprobará el saludo).');
}

/** Empaqueta mulaw crudo en un WAV (WAVE_FORMAT_MULAW) para poder escucharlo. */
function toWav(mulaw) {
  const padded = mulaw.length % 2 === 1 ? Buffer.concat([mulaw, Buffer.alloc(1, 0xff)]) : mulaw;
  const header = Buffer.alloc(58);
  let offset = 0;
  header.write('RIFF', offset); offset += 4;
  header.writeUInt32LE(50 + padded.length, offset); offset += 4;
  header.write('WAVE', offset); offset += 4;
  header.write('fmt ', offset); offset += 4;
  header.writeUInt32LE(18, offset); offset += 4; // tamaño del bloque fmt
  header.writeUInt16LE(7, offset); offset += 2; // 7 = mulaw
  header.writeUInt16LE(1, offset); offset += 2; // canales
  header.writeUInt32LE(SAMPLE_RATE, offset); offset += 4;
  header.writeUInt32LE(SAMPLE_RATE, offset); offset += 4; // bytes por segundo
  header.writeUInt16LE(1, offset); offset += 2; // alineación de bloque
  header.writeUInt16LE(8, offset); offset += 2; // bits por muestra
  header.writeUInt16LE(0, offset); offset += 2; // sin datos extra
  header.write('fact', offset); offset += 4;
  header.writeUInt32LE(4, offset); offset += 4;
  header.writeUInt32LE(padded.length, offset); offset += 4;
  header.write('data', offset); offset += 4;
  header.writeUInt32LE(padded.length, offset);
  return Buffer.concat([header, padded]);
}

const ws = new WebSocket(url);
const received = [];
let sourceOffset = 0;
let sourceDone = false;

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
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: SAMPLE_RATE, channels: 1 },
      },
    }),
  );

  let sequence = 2;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(timer);

    const speaking = Date.now() - startedAt >= delaySeconds * 1000;
    let frame = SILENCE;
    if (source && speaking && sourceOffset < source.length) {
      if (sourceOffset === 0) console.log(`[${delaySeconds}s] enviando la pregunta…`);
      frame = source.subarray(sourceOffset, sourceOffset + FRAME_BYTES);
      sourceOffset += FRAME_BYTES;
      if (sourceOffset >= source.length) {
        sourceDone = true;
        console.log('Pregunta enviada entera; a partir de aquí, silencio.');
      }
    }

    ws.send(
      JSON.stringify({
        event: 'media',
        sequenceNumber: String(sequence++),
        streamSid,
        media: {
          track: 'inbound',
          chunk: String(sequence),
          timestamp: String(sequence * 20),
          payload: frame.toString('base64'),
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
    if (received.length === 0) console.log('Primer audio del agente recibido');
    received.push(Buffer.from(data.media.payload, 'base64'));
    return;
  }
  console.log('Evento recibido:', data.event);
});

ws.on('close', () => {
  const audio = Buffer.concat(received);
  const ms = Math.round((audio.length / SAMPLE_RATE) * 1000);
  console.log(`\nCerrado. ${received.length} mensajes, ${audio.length} bytes (~${ms} ms de voz).`);

  if (audio.length === 0) {
    console.log('Sin audio del agente: revisa DEEPGRAM_API_KEY y los logs del servidor.');
    return;
  }

  writeFileSync(outPath, toWav(audio));
  console.log(`OK: el agente respondió. Audio guardado en ${outPath}`);
  console.log(`Escúchalo con:  afplay ${outPath}`);
  if (source && !sourceDone) {
    console.log('Aviso: --seconds se agotó antes de enviar toda la pregunta.');
  }
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
