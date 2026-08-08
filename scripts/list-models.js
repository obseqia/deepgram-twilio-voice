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
  console.log(
    '\nUn 403 "subscription tier" en modelos comerciales (OpenAI, Anthropic) tiene\n' +
      'dos causas posibles, y el mensaje de DigitalOcean es el mismo para ambas:\n' +
      '  1. La cuenta está por debajo de tier 3. Se sube con un prepago en el\n' +
      '     Control Panel.\n' +
      '  2. La model access key se creó con un scope de modelos que no los\n' +
      '     incluye. El scope NO se puede editar: hay que crear otra clave con\n' +
      '     "All models".\n' +
      'Para distinguirlas, pon un personal access token en\n' +
      'DIGITALOCEAN_MODEL_ACCESS_KEY y repite: la API acepta los dos, así que si\n' +
      'con el token sí funcionan, el problema era el scope de la clave.\n' +
      'Los modelos de pesos abiertos funcionan en cualquiera de los dos casos.',
  );
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
