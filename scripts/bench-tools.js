/**
 * Banco de pruebas de tool calling.
 *
 *   pnpm bench                          todos los modelos de DIGITALOCEAN_MODELS
 *   pnpm bench --models a,b             solo esos
 *   pnpm bench --runs 3                 repite cada caso (las latencias varían)
 *   pnpm bench --verbose                detalle caso por caso
 *
 * Llama al LLM directamente, no a través de la llamada de voz. Es a propósito:
 * medir el tool calling a través de TTS→STT mete el ruido del reconocimiento en
 * cada medición, y lo que se quiere comparar aquí es el modelo.
 */
import { config } from '../src/config.js';
import { openAiTools, runTool, TOOLS } from '../src/tools.js';
import { DIGITALOCEAN_MODELS } from '../src/config.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const models = flag('--models', '')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const runs = Number(flag('--runs', 1));
const verbose = args.includes('--verbose');

// --endpoint / --key permiten apuntar a otro servicio compatible con OpenAI
// (o a un mock) sin tocar el .env.
const thinkEndpointUrl = flag('--endpoint', config.agent.thinkEndpointUrl);
const thinkApiKey = flag('--key', config.agent.thinkApiKey);

if (!thinkEndpointUrl || !thinkApiKey) {
  console.error(
    'Este banco de pruebas necesita el endpoint propio.\n' +
      'Configura THINK_PROVIDER=digitalocean y DIGITALOCEAN_MODEL_ACCESS_KEY en el .env.',
  );
  process.exit(1);
}

const now = new Date();
const TODAY = now.toLocaleDateString('en-CA');
const TOMORROW = new Date(now.getTime() + 86400000).toLocaleDateString('en-CA');

const SYSTEM = `You are a helpful travel concierge assistant speaking over the phone. Keep answers short. Reply in the caller's language. Today is ${now.toLocaleDateString('en-US', { weekday: 'long' })}, ${TODAY}. Use it to resolve relative dates like "tomorrow". Only call a tool when you actually need external data; answer general knowledge questions directly.`;

const near = (value, target, tolerance = 1) => Math.abs(Number(value) - target) <= tolerance;

/**
 * Casos con su resultado esperado.
 *
 * `tools` es el conjunto que debería acabar llamando; `chain` marca los casos
 * donde get_weather solo puede resolverse con lo que devuelve resolve_location.
 */
const CASES = [
  {
    id: 'weather-city',
    utterance: '¿Qué temperatura hace en Monterrey?',
    tools: ['resolve_location', 'get_weather'],
    chain: true,
    args: {
      resolve_location: (a) => /monterrey/i.test(a.query ?? ''),
      get_weather: (a) => near(a.latitude, 25.68, 1) && near(a.longitude, -100.32, 1),
    },
  },
  {
    id: 'weather-tomorrow',
    utterance: '¿Va a llover mañana en Austin?',
    tools: ['resolve_location', 'get_weather'],
    chain: true,
    args: {
      resolve_location: (a) => /austin/i.test(a.query ?? ''),
      get_weather: (a) => a.date === TOMORROW,
    },
  },
  {
    id: 'currency',
    utterance: '¿Cuántos pesos son 125 dólares?',
    tools: ['convert_currency'],
    args: {
      convert_currency: (a) =>
        Number(a.amount) === 125 && /usd/i.test(a.from ?? '') && /mxn/i.test(a.to ?? ''),
    },
  },
  {
    id: 'combined',
    utterance:
      'Voy mañana a Austin. ¿Cómo estará el clima y cuánto son 250 dólares en pesos mexicanos?',
    tools: ['resolve_location', 'get_weather', 'convert_currency'],
    chain: true,
    args: {
      resolve_location: (a) => /austin/i.test(a.query ?? ''),
      get_weather: (a) => a.date === TOMORROW,
      convert_currency: (a) => Number(a.amount) === 250 && /mxn/i.test(a.to ?? ''),
    },
  },
  {
    id: 'business-hours',
    utterance: '¿A qué hora abren el sábado?',
    tools: ['get_business_hours'],
    args: {
      get_business_hours: (a) => /saturday|s[áa]bado/i.test(a.day ?? ''),
    },
  },
  {
    // El caso que de verdad separa a los modelos: no hay nada que consultar.
    id: 'no-tool',
    utterance: 'Explícame qué es una tormenta eléctrica.',
    tools: [],
  },
];

/**
 * Una ronda de chat en streaming. Devuelve las tool calls, el texto y los dos
 * tiempos que importan: el primer token y el final de la respuesta.
 */
async function streamChat(model, messages) {
  const startedAt = Date.now();
  let ttft = null;

  const response = await fetch(thinkEndpointUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${thinkApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages, tools: openAiTools(), stream: true }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const toolCalls = [];
  let content = '';
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      ttft ??= Date.now() - startedAt;

      if (delta.content) content += delta.content;

      // Las tool calls llegan troceadas: los argumentos se van concatenando
      // por índice a lo largo de varios deltas.
      for (const call of delta.tool_calls ?? []) {
        const slot = (toolCalls[call.index] ??= { id: '', name: '', arguments: '' });
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name += call.function.name;
        if (call.function?.arguments) slot.arguments += call.function.arguments;
      }
    }
  }

  return {
    toolCalls: toolCalls.filter(Boolean),
    content,
    ttft: ttft ?? Date.now() - startedAt,
    total: Date.now() - startedAt,
  };
}

/** Ejecuta un caso completo: pregunta, tools, y respuesta final. */
async function runCase(model, testCase) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: testCase.utterance },
  ];

  const called = [];
  const results = new Map();
  let decisionTtft = null;
  let decisionDone = null;
  let continuationTtft = null;
  let toolMs = 0;
  let parallel = false;
  const startedAt = Date.now();

  for (let round = 0; round < 4; round += 1) {
    const step = await streamChat(model, messages);

    if (round === 0) {
      decisionTtft = step.ttft;
      decisionDone = step.total;
    }

    if (step.toolCalls.length === 0) {
      // Primera ronda sin tools = el modelo decidió contestar directamente.
      continuationTtft ??= step.ttft;
      return {
        called,
        results,
        parallel,
        answer: step.content,
        latency: {
          decisionTtft,
          decisionDone,
          toolMs,
          continuationTtft,
          total: Date.now() - startedAt,
        },
      };
    }

    if (step.toolCalls.length > 1) parallel = true;

    messages.push({
      role: 'assistant',
      tool_calls: step.toolCalls.map((call, index) => ({
        id: call.id || `call_${round}_${index}`,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    const executed = await Promise.all(
      step.toolCalls.map(async (call, index) => {
        let parsedArgs = {};
        try {
          parsedArgs = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          parsedArgs = { __unparsable: call.arguments };
        }
        const outcome = await runTool(call.name, parsedArgs);
        called.push({ name: call.name, args: parsedArgs });
        results.set(call.name, outcome.result);
        return { call, index, parsedArgs, outcome };
      }),
    );

    // Las tools van en paralelo, así que el coste del turno es la más lenta.
    toolMs += Math.max(0, ...executed.map((item) => item.outcome.ms));

    for (const { call, index, outcome } of executed) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id || `call_${round}_${index}`,
        content: JSON.stringify(outcome.result),
      });
    }
  }

  return {
    called,
    results,
    parallel,
    answer: '(sin respuesta final tras 4 rondas)',
    latency: { decisionTtft, decisionDone, toolMs, continuationTtft, total: Date.now() - startedAt },
  };
}

/** Compara lo que hizo el modelo con lo que se esperaba. */
function score(testCase, outcome) {
  const expected = new Set(testCase.tools);
  const actual = new Set(outcome.called.map((call) => call.name));

  const missing = [...expected].filter((name) => !actual.has(name));
  const unnecessary = [...actual].filter((name) => !expected.has(name));

  // Argumentos: se valida la primera llamada de cada herramienta.
  let argsChecked = 0;
  let argsOk = 0;
  for (const [name, check] of Object.entries(testCase.args ?? {})) {
    const call = outcome.called.find((item) => item.name === name);
    if (!call) continue;
    argsChecked += 1;
    if (check(call.args)) argsOk += 1;
  }

  // Encadenado: get_weather tiene que haber recibido las coordenadas que
  // devolvió resolve_location, no unas inventadas.
  let chainOk = null;
  if (testCase.chain) {
    const place = outcome.results.get('resolve_location');
    const weather = outcome.called.find((call) => call.name === 'get_weather');
    chainOk = Boolean(
      place?.found &&
        weather &&
        near(weather.args.latitude, place.latitude, 0.5) &&
        near(weather.args.longitude, place.longitude, 0.5),
    );
  }

  return {
    selectionOk: missing.length === 0 && unnecessary.length === 0,
    missing,
    unnecessary,
    argsChecked,
    argsOk,
    chainOk,
    multiTool: expected.size > 1,
    parallel: outcome.parallel,
  };
}

const percent = (ok, total) => (total === 0 ? '  —  ' : `${String(Math.round((ok / total) * 100)).padStart(3)}%`);
const median = (values) => {
  const clean = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  return clean[Math.floor(clean.length / 2)];
};

const targets = models.length > 0 ? models : DIGITALOCEAN_MODELS;
console.log(`Casos: ${CASES.length} · repeticiones: ${runs} · herramientas: ${TOOLS.length}`);
console.log(`Modelos: ${targets.join(', ')}\n`);

const summary = [];

for (const model of targets) {
  const tally = {
    selection: 0,
    cases: 0,
    argsOk: 0,
    argsChecked: 0,
    chainOk: 0,
    chainCases: 0,
    multiOk: 0,
    multiCases: 0,
    unnecessary: 0,
    missing: 0,
    parallelCases: 0,
    errors: 0,
  };
  const latencies = { decision: [], decisionDone: [], tools: [], continuation: [], total: [] };

  process.stdout.write(`${model}\n`);

  for (let run = 0; run < runs; run += 1) {
    for (const testCase of CASES) {
      let outcome;
      try {
        outcome = await runCase(model, testCase);
      } catch (err) {
        tally.errors += 1;
        console.log(`  ✗ ${testCase.id}: ${err.message}`);
        continue;
      }

      const result = score(testCase, outcome);
      tally.cases += 1;
      if (result.selectionOk) tally.selection += 1;
      tally.argsOk += result.argsOk;
      tally.argsChecked += result.argsChecked;
      tally.unnecessary += result.unnecessary.length;
      tally.missing += result.missing.length;
      if (result.chainOk !== null) {
        tally.chainCases += 1;
        if (result.chainOk) tally.chainOk += 1;
      }
      if (result.multiTool) {
        tally.multiCases += 1;
        if (result.selectionOk) tally.multiOk += 1;
      }
      if (result.parallel) tally.parallelCases += 1;

      latencies.decision.push(outcome.latency.decisionTtft);
      latencies.decisionDone.push(outcome.latency.decisionDone);
      latencies.tools.push(outcome.latency.toolMs);
      latencies.continuation.push(outcome.latency.continuationTtft);
      latencies.total.push(outcome.latency.total);

      const mark = result.selectionOk && result.chainOk !== false ? '✓' : '✗';
      console.log(
        `  ${mark} ${testCase.id.padEnd(17)} ${String(outcome.latency.total).padStart(5)}ms  ` +
          `[${outcome.called.map((call) => call.name).join(' → ') || 'sin tools'}]`,
      );
      if (verbose) {
        if (result.missing.length) console.log(`      falta: ${result.missing.join(', ')}`);
        if (result.unnecessary.length) console.log(`      sobra: ${result.unnecessary.join(', ')}`);
        if (result.argsChecked > result.argsOk) {
          console.log(
            `      args: ${result.argsOk}/${result.argsChecked} — ` +
              outcome.called.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(' '),
          );
        }
        console.log(`      → ${outcome.answer.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  }

  summary.push({ model, tally, latencies });
  console.log('');
}

const head = (text, width) => text.padEnd(width);
console.log('CALIDAD');
console.log(
  `${head('modelo', 28)} ${head('selección', 10)} ${head('args', 7)} ${head('cadena', 8)} ` +
    `${head('multi', 7)} ${head('sobran', 7)} ${head('faltan', 7)} paralelo`,
);
for (const { model, tally } of summary) {
  console.log(
    `${head(model, 28)} ${head(percent(tally.selection, tally.cases), 10)} ` +
      `${head(percent(tally.argsOk, tally.argsChecked), 7)} ` +
      `${head(percent(tally.chainOk, tally.chainCases), 8)} ` +
      `${head(percent(tally.multiOk, tally.multiCases), 7)} ` +
      `${head(String(tally.unnecessary), 7)} ${head(String(tally.missing), 7)} ` +
      `${tally.parallelCases}/${tally.cases}`,
  );
}

console.log('\nLATENCIA (mediana, ms)');
console.log(
  `${head('modelo', 28)} ${head('decisión', 10)} ${head('tool call', 11)} ${head('externa', 9)} ` +
    `${head('continúa', 10)} total`,
);
for (const { model, latencies } of summary) {
  console.log(
    `${head(model, 28)} ${head(String(median(latencies.decision)), 10)} ` +
      `${head(String(median(latencies.decisionDone)), 11)} ` +
      `${head(String(median(latencies.tools)), 9)} ` +
      `${head(String(median(latencies.continuation)), 10)} ${median(latencies.total)}`,
  );
}

const failed = summary.filter(({ tally }) => tally.errors > 0);
if (failed.length) {
  console.log(`\nModelos con errores: ${failed.map(({ model }) => model).join(', ')}`);
}
