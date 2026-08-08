/**
 * Herramientas del agente: un "travel concierge" mínimo.
 *
 * No es el producto, es un banco de pruebas. Estas cuatro funciones generan los
 * mismos patrones que después aparecen en ecommerce o reservas: elegir la
 * herramienta correcta, extraer bien los argumentos, encadenar una llamada con
 * el resultado de otra, y combinar dos cadenas independientes en una respuesta.
 *
 * Las tres externas no necesitan clave. La cuarta es local y responde en
 * 50-150 ms, para tener una referencia de latencia sin red de por medio.
 */

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
// Ojo: api.frankfurter.app redirige 301 al .dev.
const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1';

/** Códigos WMO que devuelve Open-Meteo, resumidos a lenguaje hablable. */
const WEATHER_CODES = {
  0: 'despejado',
  1: 'mayormente despejado',
  2: 'parcialmente nublado',
  3: 'nublado',
  45: 'con niebla',
  48: 'con niebla helada',
  51: 'con llovizna ligera',
  53: 'con llovizna',
  55: 'con llovizna intensa',
  61: 'con lluvia ligera',
  63: 'con lluvia',
  65: 'con lluvia fuerte',
  71: 'con nieve ligera',
  73: 'con nieve',
  75: 'con nieve intensa',
  80: 'con chubascos',
  81: 'con chubascos fuertes',
  82: 'con chubascos muy fuertes',
  95: 'con tormenta eléctrica',
  96: 'con tormenta y granizo',
  99: 'con tormenta fuerte y granizo',
};

const describeCode = (code) => WEATHER_CODES[code] ?? 'sin datos de condición';

async function getJson(url, params) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) target.searchParams.set(key, value);
  }
  const response = await fetch(target, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    throw new Error(`${target.host} respondió ${response.status}`);
  }
  return response.json();
}

/** Horario de la empresa ficticia, para la herramienta local. */
const BUSINESS_HOURS = {
  monday: '9:00–18:00',
  tuesday: '9:00–18:00',
  wednesday: '9:00–18:00',
  thursday: '9:00–18:00',
  friday: '9:00–17:00',
  saturday: '10:00–14:00',
  sunday: 'cerrado',
};

const DAY_ALIASES = {
  lunes: 'monday',
  martes: 'tuesday',
  miercoles: 'wednesday',
  miércoles: 'wednesday',
  jueves: 'thursday',
  viernes: 'friday',
  sabado: 'saturday',
  sábado: 'saturday',
  domingo: 'sunday',
};

export const TOOLS = [
  {
    name: 'resolve_location',
    description:
      'Convierte el nombre de una ciudad o lugar en coordenadas geográficas. ' +
      'Úsala antes de get_weather siempre que el usuario mencione un lugar por su nombre.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Nombre de la ciudad o lugar, por ejemplo "Monterrey" o "Austin, Texas".',
        },
      },
      required: ['query'],
    },
    async run({ query }) {
      const data = await getJson(GEOCODING_URL, {
        name: query,
        count: 1,
        language: 'es',
        format: 'json',
      });
      const [place] = data.results ?? [];
      if (!place) return { found: false, message: `No encontré ningún lugar llamado "${query}".` };

      return {
        found: true,
        name: place.name,
        country: place.country,
        admin1: place.admin1,
        latitude: place.latitude,
        longitude: place.longitude,
        timezone: place.timezone,
      };
    },
  },

  {
    name: 'get_weather',
    description:
      'Consulta el clima para unas coordenadas. Requiere latitud y longitud, ' +
      'que se obtienen antes con resolve_location.',
    parameters: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'Latitud en grados decimales.' },
        longitude: { type: 'number', description: 'Longitud en grados decimales.' },
        date: {
          type: 'string',
          description:
            'Fecha en formato YYYY-MM-DD. Omitir para el clima actual. ' +
            'Para "mañana", usar la fecha de mañana.',
        },
      },
      required: ['latitude', 'longitude'],
    },
    async run({ latitude, longitude, date }) {
      const data = await getJson(FORECAST_URL, {
        latitude,
        longitude,
        current: date ? undefined : 'temperature_2m,weather_code',
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
        timezone: 'auto',
        forecast_days: 7,
      });

      if (!date) {
        return {
          when: 'ahora',
          temperature_c: data.current.temperature_2m,
          condition: describeCode(data.current.weather_code),
          timezone: data.timezone,
        };
      }

      const index = data.daily.time.indexOf(date);
      if (index === -1) {
        return {
          error: `Sin pronóstico para ${date}. Disponible de ${data.daily.time[0]} a ${data.daily.time.at(-1)}.`,
        };
      }

      return {
        when: date,
        temperature_max_c: data.daily.temperature_2m_max[index],
        temperature_min_c: data.daily.temperature_2m_min[index],
        precipitation_probability: data.daily.precipitation_probability_max[index],
        condition: describeCode(data.daily.weather_code[index]),
        timezone: data.timezone,
      };
    },
  },

  {
    name: 'convert_currency',
    description: 'Convierte una cantidad de una divisa a otra con el tipo de cambio del día.',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Cantidad a convertir.' },
        from: { type: 'string', description: 'Divisa de origen en ISO 4217, por ejemplo USD.' },
        to: { type: 'string', description: 'Divisa de destino en ISO 4217, por ejemplo MXN.' },
      },
      required: ['amount', 'from', 'to'],
    },
    async run({ amount, from, to }) {
      const base = String(from).toUpperCase();
      const target = String(to).toUpperCase();
      const data = await getJson(`${FRANKFURTER_URL}/latest`, { base, symbols: target });
      const rate = data.rates?.[target];
      if (rate === undefined) {
        return { error: `No hay tipo de cambio de ${base} a ${target}.` };
      }
      return {
        amount,
        from: base,
        to: target,
        rate,
        result: Number((amount * rate).toFixed(2)),
        date: data.date,
      };
    },
  },

  {
    name: 'get_business_hours',
    description: 'Devuelve el horario de atención de la empresa para un día de la semana.',
    parameters: {
      type: 'object',
      properties: {
        day: {
          type: 'string',
          description: 'Día de la semana, por ejemplo "monday" o "lunes".',
        },
      },
      required: ['day'],
    },
    async run({ day }) {
      // Latencia artificial de 50-150 ms: una herramienta local realista, sin
      // red de por medio, como referencia frente a las tres externas.
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));

      const key = DAY_ALIASES[String(day).toLowerCase()] ?? String(day).toLowerCase();
      const hours = BUSINESS_HOURS[key];
      if (!hours) return { error: `"${day}" no es un día de la semana válido.` };
      return { day: key, hours };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** Declaración de funciones para el mensaje `Settings` de Deepgram. */
export function deepgramFunctions() {
  // Sin `endpoint`, Deepgram las trata como client-side: nos manda un
  // FunctionCallRequest y espera que respondamos nosotros.
  return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/** Las mismas funciones en el formato de tools de la API de OpenAI. */
export function openAiTools() {
  return TOOLS.map(({ name, description, parameters }) => ({
    type: 'function',
    function: { name, description, parameters },
  }));
}

/**
 * Ejecuta una herramienta y mide cuánto tarda.
 *
 * Nunca lanza: un fallo de la API externa se devuelve como resultado para que
 * el modelo pueda explicárselo al usuario en vez de cortar la llamada.
 */
export async function runTool(name, args) {
  const startedAt = Date.now();
  const tool = BY_NAME.get(name);

  if (!tool) {
    return { ok: false, ms: 0, result: { error: `No existe la herramienta "${name}".` } };
  }

  try {
    const result = await tool.run(args ?? {});
    return { ok: true, ms: Date.now() - startedAt, result };
  } catch (err) {
    return { ok: false, ms: Date.now() - startedAt, result: { error: err.message } };
  }
}
