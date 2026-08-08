/**
 * Lista los modelos disponibles en el endpoint de inferencia configurado y,
 * opcionalmente, comprueba que el modelo elegido responde de verdad.
 *
 *   node scripts/list-models.js           lista los modelos
 *   node scripts/list-models.js --test    además prueba el de THINK_MODEL
 *
 * Sirve para elegir THINK_MODEL antes de gastar una llamada entera, y para
 * distinguir un problema de credenciales de uno de configuración del agente.
 */
import { config, DIGITALOCEAN_INFERENCE_URL, DIGITALOCEAN_MODELS } from '../src/config.js';

const { thinkEndpointUrl, thinkApiKey, thinkModel } = config.agent;

if (!thinkEndpointUrl) {
  console.error(
    'Ahora mismo se usa el LLM que incluye Deepgram.\n' +
      'Para usar los tuyos: THINK_PROVIDER=digitalocean y DIGITALOCEAN_MODEL_ACCESS_KEY.',
  );
  process.exit(1);
}

if (!thinkApiKey) {
  console.error('Falta DIGITALOCEAN_MODEL_ACCESS_KEY en el .env.');
  process.exit(1);
}

const auth = { authorization: `Bearer ${thinkApiKey}` };

console.log(`Endpoint : ${thinkEndpointUrl}`);
console.log(`Modelo   : ${thinkModel}\n`);

// El listado cuelga de la raíz de la API, no del endpoint de chat.
const response = await fetch(`${DIGITALOCEAN_INFERENCE_URL}/models`, { headers: auth });

if (!response.ok) {
  console.error(`No se pudo listar modelos: HTTP ${response.status} ${response.statusText}`);
  console.error(await response.text());
  process.exit(1);
}

const { data = [] } = await response.json();
const ids = data.map((model) => model.id).sort();

console.log(`Modelos disponibles (${ids.length}):`);
for (const id of ids) {
  const mark = id === thinkModel ? '▸' : DIGITALOCEAN_MODELS.includes(id) ? '·' : ' ';
  console.log(`  ${mark} ${id}`);
}

// El listado de /v1/models es el catálogo entero de DigitalOcean, no lo que tu
// clave puede usar: los modelos comerciales (OpenAI, Anthropic) aparecen ahí
// pero devuelven 403 si la cuenta no es tier 2. La única forma de saberlo es
// pedirle un token a cada uno.
console.log('\nModelos a comparar (acceso comprobado de verdad, no solo el catálogo):');
const access = await Promise.all(
  DIGITALOCEAN_MODELS.map(async (id) => {
    if (!ids.includes(id)) return { id, state: 'no está en el catálogo' };
    try {
      const probe = await fetch(thinkEndpointUrl, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: id,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (probe.ok) return { id, state: 'ok' };
      const body = await probe.json().catch(() => ({}));
      return { id, state: `HTTP ${probe.status}: ${body.error?.message ?? 'sin detalle'}` };
    } catch (err) {
      return { id, state: err.message };
    }
  }),
);

for (const { id, state } of access) {
  const mark = state === 'ok' ? (id === thinkModel ? '▸' : '·') : '✗';
  const baseline = id === DIGITALOCEAN_MODELS[0] ? ' (baseline)' : '';
  console.log(`  ${mark} ${id}${baseline}${state === 'ok' ? '' : ` — ${state}`}`);
}

if (access.some(({ state }) => /403|subscription tier/.test(state))) {
  // Tier 1 y 2 de Inference no dan acceso a ningún modelo de OpenAI ni de
  // Anthropic salvo dos excepciones: gpt-oss-120b y gpt-oss-20b. Si esas dos
  // pasan y el resto no, el problema es el tier y no el scope de la clave.
  const probe = async (id) => {
    const res = await fetch(thinkEndpointUrl, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    return res?.ok ?? false;
  };
  const ossWorks = await probe('openai-gpt-oss-120b');

  console.log(
    `\nDiagnóstico del 403 (openai-gpt-oss-120b ${ossWorks ? 'sí' : 'no'} funciona con esta clave):`,
  );
  if (ossWorks) {
    console.log(
      '  Es el tier de Inference: sus tiers 1 y 2 excluyen todo OpenAI y Anthropic\n' +
        '  salvo gpt-oss-120b y gpt-oss-20b, que es exactamente lo que pasa aquí.\n' +
        '  Ojo: ese tier es propio de Serverless Inference y se sube con su propio\n' +
        '  prepago, no es el resource tier que muestra el panel de la cuenta.\n' +
        '  Control Panel → Gradient AI → Serverless Inference → prepayment.',
    );
  } else {
    console.log(
      '  Ni gpt-oss pasa, así que apunta al scope de la model access key: se fija\n' +
        '  al crearla y no se puede editar. Crea otra con "All models".',
    );
  }
}

if (!process.argv.includes('--test')) process.exit(0);

console.log(`\nProbando ${thinkModel}…`);
const started = Date.now();
const chat = await fetch(thinkEndpointUrl, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: thinkModel,
    messages: [
      { role: 'system', content: 'Responde en el mismo idioma en que te hablen. Sé breve.' },
      { role: 'user', content: 'Hola, ¿cuál es el horario de atención?' },
    ],
    max_tokens: 100,
  }),
});

if (!chat.ok) {
  console.error(`Falló la petición: HTTP ${chat.status} ${chat.statusText}`);
  console.error(await chat.text());
  process.exit(1);
}

const result = await chat.json();
console.log(`Respuesta (${Date.now() - started} ms): ${result.choices?.[0]?.message?.content}`);
console.log('OK: el modelo responde y el agente puede usarlo.');
