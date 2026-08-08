/**
 * Catálogo de voces de Aura-2 relevantes para este proyecto y validación de la
 * combinación voz/idiomas.
 *
 * El detalle que se pasa por alto con facilidad: una voz de Aura-2 está atada a
 * un idioma (el sufijo del nombre, `aura-2-thalia-en`). Si le pides a una voz
 * inglesa que diga una frase en español, la dirá — pero leyéndola como si fuera
 * inglés. Solo cinco voces españolas están preparadas para alternar entre
 * español e inglés dentro de una misma respuesta.
 *
 * Fuente: https://developers.deepgram.com/docs/tts-models
 */

/** Voces españolas que hacen code-switching es/en de forma nativa. */
export const CODESWITCHING_ES_EN = {
  'aura-2-aquila-es': 'masculina — expresiva, entusiasta, cercana',
  'aura-2-carina-es': 'femenina — profesional, enérgica, segura',
  'aura-2-diana-es': 'femenina — profesional, expresiva, resolutiva',
  'aura-2-javier-es': 'masculina — cercana, profesional, tranquila',
  'aura-2-selena-es': 'femenina — natural, amable, cercana',
};

/** Pares de idiomas que una sola voz de Deepgram puede cubrir. */
const DEEPGRAM_CODESWITCHING_PAIRS = [
  { languages: ['en', 'es'], voices: CODESWITCHING_ES_EN },
];

/** Extrae el idioma del nombre del modelo: `aura-2-diana-es` → `es`. */
export function voiceLanguage(model) {
  const match = /-([a-z]{2})$/.exec(model ?? '');
  return match ? match[1] : null;
}

/**
 * Comprueba que la voz elegida sirve para los idiomas que el agente debe hablar.
 *
 * Devuelve `{ ok, level, message, suggestions }`. Nunca lanza: la decisión de
 * abortar o solo avisar es de quien llama.
 */
export function validateVoice(model, languages) {
  const langs = [...new Set(languages)].sort();
  const voiceLang = voiceLanguage(model);

  if (langs.length <= 1) {
    const [only] = langs;
    if (only && voiceLang && voiceLang !== only) {
      return {
        ok: false,
        level: 'error',
        message:
          `La voz ${model} es de idioma "${voiceLang}" pero el agente habla "${only}". ` +
          'Pronunciará el texto con la fonética equivocada.',
        suggestions: [],
      };
    }
    return { ok: true, level: 'info', message: `Voz ${model} para "${only ?? 'en'}".` };
  }

  const pair = DEEPGRAM_CODESWITCHING_PAIRS.find(
    (candidate) =>
      candidate.languages.length === langs.length &&
      candidate.languages.every((lang) => langs.includes(lang)),
  );

  if (!pair) {
    return {
      ok: false,
      level: 'error',
      message:
        `Deepgram TTS no tiene una voz que alterne entre ${langs.join(' y ')} en una misma ` +
        'respuesta. Para esa combinación hace falta un proveedor externo (Cartesia, ' +
        'ElevenLabs u OpenAI) con speak.provider.language = "multi".',
      suggestions: [],
    };
  }

  if (!(model in pair.voices)) {
    return {
      ok: false,
      level: 'error',
      message:
        `La voz ${model} no hace code-switching ${langs.join('/')}: leerá el otro idioma ` +
        'con la fonética equivocada.',
      suggestions: Object.entries(pair.voices).map(([id, desc]) => `${id} (${desc})`),
    };
  }

  return {
    ok: true,
    level: 'info',
    message: `Voz ${model} con code-switching ${langs.join('/')}: ${pair.voices[model]}.`,
  };
}
