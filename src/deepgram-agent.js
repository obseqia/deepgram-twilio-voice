import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import { config } from './config.js';
import { buildSettings } from './agent-settings.js';
import { runTool } from './tools.js';

const KEEPALIVE_INTERVAL_MS = 8000;

/**
 * Conexión con la Voice Agent API de Deepgram.
 *
 * Eventos que emite:
 *   - `ready`                → settings enviados, la sesión acepta audio
 *   - `audio` (Buffer)       → audio mulaw 8 kHz generado por el agente
 *   - `userStartedSpeaking`  → el usuario interrumpió (barge-in)
 *   - `event` (object)       → cualquier mensaje JSON del servidor
 *   - `error` (Error)
 *   - `close` (code, reason)
 */
export class DeepgramAgent extends EventEmitter {
  #ws;
  #ready = false;
  #closed = false;
  #pending = [];
  #keepAlive = null;

  connect() {
    this.#ws = new WebSocket(config.deepgram.agentUrl, {
      headers: { Authorization: `Token ${config.deepgram.apiKey}` },
    });

    this.#ws.on('open', () => {
      // Deepgram manda `Welcome` nada más abrir; los `Settings` se envían al
      // recibirlo. Mientras tanto, el audio entrante se queda en cola.
      this.#keepAlive = setInterval(() => {
        this.#sendJson({ type: 'KeepAlive' });
      }, KEEPALIVE_INTERVAL_MS);
    });

    this.#ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.emit('audio', Buffer.isBuffer(data) ? data : Buffer.from(data));
        return;
      }
      this.#handleTextMessage(data.toString());
    });

    this.#ws.on('error', (err) => this.emit('error', err));

    this.#ws.on('close', (code, reason) => {
      this.#cleanup();
      this.emit('close', code, reason.toString());
    });

    return this;
  }

  #handleTextMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.emit('error', new Error(`Mensaje no-JSON de Deepgram: ${raw}`));
      return;
    }

    switch (message.type) {
      case 'Welcome':
        this.#sendSettings();
        break;
      case 'UserStartedSpeaking':
        this.emit('userStartedSpeaking');
        break;
      case 'FunctionCallRequest':
        this.#handleFunctionCalls(message);
        break;
      case 'Error':
        this.emit('error', new Error(message.description ?? JSON.stringify(message)));
        break;
      default:
        break;
    }

    this.emit('event', message);
  }

  /**
   * Ejecuta las funciones que pide el agente y le devuelve el resultado.
   *
   * Van en paralelo a propósito: cuando el modelo pide varias de golpe (por
   * ejemplo clima y tipo de cambio en la misma frase), encadenarlas duplicaría
   * el silencio que oye quien llama.
   */
  async #handleFunctionCalls(message) {
    const calls = (message.functions ?? []).filter((call) => call.client_side !== false);

    await Promise.all(
      calls.map(async (call) => {
        let args = {};
        try {
          args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
        } catch {
          this.emit('error', new Error(`Argumentos ilegibles en ${call.name}: ${call.arguments}`));
        }

        const { ok, ms, result } = await runTool(call.name, args);
        this.emit('toolCall', { name: call.name, args, ms, ok, result });

        this.#sendJson({
          type: 'FunctionCallResponse',
          id: call.id,
          name: call.name,
          content: JSON.stringify(result),
        });
      }),
    );
  }

  #sendSettings() {
    this.#sendJson(buildSettings());
    this.#ready = true;
    this.emit('ready');
    this.#flush();
  }

  #flush() {
    while (this.#pending.length > 0 && this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(this.#pending.shift());
    }
  }

  #sendJson(payload) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(payload));
    }
  }

  /** Envía audio mulaw 8 kHz al agente; hace cola si la sesión aún no está lista. */
  sendAudio(chunk) {
    if (this.#closed) return;
    if (!this.#ready || this.#ws?.readyState !== WebSocket.OPEN) {
      this.#pending.push(chunk);
      return;
    }
    this.#ws.send(chunk);
  }

  #cleanup() {
    this.#closed = true;
    this.#ready = false;
    this.#pending = [];
    if (this.#keepAlive) {
      clearInterval(this.#keepAlive);
      this.#keepAlive = null;
    }
  }

  close() {
    if (this.#closed) return;
    this.#cleanup();
    if (
      this.#ws?.readyState === WebSocket.OPEN ||
      this.#ws?.readyState === WebSocket.CONNECTING
    ) {
      this.#ws.close(1000, 'call ended');
    }
  }
}
