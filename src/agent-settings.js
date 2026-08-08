import { config } from './config.js';

const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
};

const name = (code) => LANGUAGE_NAMES[code] ?? code;

/**
 * Instrucción de idioma que se añade al prompt del usuario.
 *
 * Sin esto el LLM tiende a contestar siempre en el idioma del prompt de
 * sistema, por bien que el STT haya transcrito la otra lengua.
 */
function languageDirective(languages) {
  if (languages.length <= 1) return '';
  const list = languages.map(name);
  const readable = `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
  return (
    `\n\nYou are bilingual in ${readable}. Always reply in the same language the ` +
    `caller is using, and switch as soon as they do, even mid-conversation. ` +
    `Never announce or comment on the language change, and never translate your ` +
    `own answer into the other language.`
  );
}

/**
 * Configuración del reconocimiento de voz.
 *
 * Flux es el modelo conversacional de Deepgram: entiende los turnos de palabra,
 * así que detecta el final de frase y las interrupciones bastante mejor que
 * Nova en una llamada. `flux-general-multi` es su variante multilingüe.
 */
function listenProvider(languages, override) {
  const onlyEnglish = languages.length === 1 && languages[0] === 'en';
  // Flux solo publica variante propia para inglés; el resto de idiomas, incluido
  // el español a solas, van por la multilingüe.
  const model = override ?? (onlyEnglish ? 'flux-general-en' : 'flux-general-multi');

  if (!model.startsWith('flux')) {
    // Escotilla de salida para volver a Nova, que no entiende de turnos pero
    // sigue admitiendo code-switching con `language: "multi"`.
    return {
      type: 'deepgram',
      model,
      language: languages.length > 1 ? 'multi' : languages[0],
    };
  }

  return {
    type: 'deepgram',
    model,
    version: 'v2',
    // Sesga el modelo hacia los idiomas esperados. Sin hints autodetecta, pero
    // fallar el idioma en la primera frase de la llamada se nota mucho.
    ...(model.endsWith('-multi') ? { language_hints: languages } : {}),
  };
}

/**
 * Configuración del LLM.
 *
 * Con un endpoint propio, Deepgram se limita a hacerle de cliente: le manda la
 * conversación en formato OpenAI y espera la respuesta en streaming. Por eso el
 * endpoint tiene que ser público y la clave se le entrega a Deepgram aquí.
 */
function thinkConfig(agent, languages) {
  const think = {
    provider: {
      type: agent.thinkProvider,
      model: agent.thinkModel,
      temperature: agent.thinkTemperature,
    },
    prompt: agent.prompt + languageDirective(languages),
  };

  if (agent.thinkEndpointUrl) {
    think.endpoint = {
      url: agent.thinkEndpointUrl,
      headers: { authorization: `Bearer ${agent.thinkApiKey}` },
    };
  }

  return think;
}

/**
 * Construye el mensaje `Settings` que inicializa la sesión del Voice Agent.
 *
 * El audio va en mulaw a 8 kHz en ambos sentidos: es exactamente el formato que
 * usa Twilio en sus Media Streams, así que no hace falta transcodificar nada.
 *
 * Nota: `agent.language` está deprecado y no se envía; el idioma se configura
 * por proveedor (`language_hints` al escuchar, voz nativa al hablar).
 */
export function buildSettings(overrides = {}) {
  const agent = { ...config.agent, ...overrides };
  const languages = agent.languages;

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
        provider: listenProvider(languages, agent.listenModel),
      },
      think: thinkConfig(agent, languages),
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
