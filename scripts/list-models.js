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

console.log('\nModelos a comparar (▸ = el activo, · = disponible, ✗ = no está en tu cuenta):');
for (const id of DIGITALOCEAN_MODELS) {
  const mark = !ids.includes(id) ? '✗' : id === thinkModel ? '▸' : '·';
  const baseline = id === DIGITALOCEAN_MODELS[0] ? '  (baseline)' : '';
  console.log(`  ${mark} ${id}${baseline}`);
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
