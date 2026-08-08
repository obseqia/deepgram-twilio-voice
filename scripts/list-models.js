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
import { config, DIGITALOCEAN_INFERENCE_URL } from '../src/config.js';

const { thinkEndpointUrl, thinkApiKey, thinkModel, thinkIsDigitalOcean } = config.agent;

if (!thinkEndpointUrl) {
  console.error(
    'No hay endpoint propio configurado: THINK_PROVIDER usa el LLM que incluye Deepgram.\n' +
      'Pon THINK_PROVIDER=digitalocean (con DIGITALOCEAN_MODEL_ACCESS_KEY) o THINK_ENDPOINT_URL.',
  );
  process.exit(1);
}

// El listado cuelga de la raíz de la API, no del endpoint de chat.
const baseUrl = thinkIsDigitalOcean
  ? DIGITALOCEAN_INFERENCE_URL
  : thinkEndpointUrl.replace(/\/chat\/completions\/?$/, '');

const auth = { authorization: `Bearer ${thinkApiKey}` };

console.log(`Endpoint : ${thinkEndpointUrl}`);
console.log(`Modelo   : ${thinkModel}\n`);

const response = await fetch(`${baseUrl}/models`, { headers: auth });

if (!response.ok) {
  console.error(`No se pudo listar modelos: HTTP ${response.status} ${response.statusText}`);
  console.error(await response.text());
  process.exit(1);
}

const { data = [] } = await response.json();
const ids = data.map((model) => model.id).sort();

console.log(`Modelos disponibles (${ids.length}):`);
for (const id of ids) {
  console.log(`  ${id === thinkModel ? '▸' : ' '} ${id}`);
}

if (!ids.includes(thinkModel)) {
  console.log(`\nAviso: THINK_MODEL="${thinkModel}" no aparece en la lista.`);
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
