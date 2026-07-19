interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * iRail MCP — Belgian rail (SNCB/NMBS) real-time via the community iRail API
 * (https://api.irail.be, keyless, https://docs.irail.be)
 *
 * Tools:
 * - irail_liveboard: departures (or arrivals) board at a Belgian station
 * - irail_journey: journey planner from A to B with legs, transfers, delays
 * - irail_train: one train by id — all stops, scheduled vs actual, delay
 * - irail_disturbances: current network disturbances and planned works
 *
 * API quirks (probed live 2026-07-19):
 * - Every endpoint answers with a 303 redirect to a versioned path; fetch
 *   must follow redirects (Workers fetch does by default — do not set
 *   redirect: 'manual').
 * - iRail asks for an identifying User-Agent; we send one on every call.
 * - Delays are in SECONDS (delay "1260" = 21 min); timestamps are unix
 *   epoch STRINGS. We convert to minutes and Europe/Brussels local ISO.
 * - Station lookup fuzzy-matches but greedily: "antwerp" resolves to
 *   Antwerp-Haven and "gent" to Gentbrugge, so major-city inputs are
 *   mapped through an alias table to the main station first. English
 *   exonyms work ("Brussels-South", "Ghent-Sint-Pieters"). Unknown
 *   stations return HTTP 400 with RequestedStopNotFoundException.
 * - Connections date format is DDMMYY, time is HHMM, timesel selects
 *   depart/arrive; interpreted in Belgian local time.
 * - platforminfo.normal === "0" means the platform CHANGED from the usual
 *   one — surfaced as platform_changed.
 */


const BASE_URL = 'https://api.irail.be';
const USER_AGENT = 'pipeworx.io (bruce@mojibake.ai)';
const TIMEOUT_MS = 8000;

const tools: McpToolExport['tools'] = [
  {
    name: 'irail_liveboard',
    description:
      'Live departures board at a Belgian train station — Belgian train times SNCB NMBS. Brussels Antwerp Ghent departures with train number, destination, scheduled time, delay in minutes, platform, and canceled flag. Set type to "arrival" for the arrivals board. Station names accept English exonyms and fuzzy input ("Brussels-South", "Antwerp-Central", "Liège-Guillemins"). Example: irail_liveboard({ station: "Brussels-South" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        station: {
          type: 'string',
          description:
            'Belgian station name, e.g. "Brussels-South", "Antwerp-Central", "Ghent-Sint-Pieters", "Leuven", "Bruges"',
        },
        type: {
          type: 'string',
          enum: ['departure', 'arrival'],
          description: 'Board type: "departure" (default) or "arrival"',
        },
        limit: { type: 'number', description: 'Max entries to return, 1-50 (default 15)' },
      },
      required: ['station'],
    },
  },
  {
    name: 'irail_journey',
    description:
      'Plan a train journey between two Belgian stations — SNCB NMBS route planner with legs, transfers, live delays, and platforms per leg. Answers "next train from Brussels to Antwerp", "how do I get from Ghent to Liège by rail". Optional depart_at or arrive_by as ISO datetime ("2026-07-20T09:00") or time ("09:00"), interpreted in Belgian local time. Example: irail_journey({ from: "Brussels-South", to: "Antwerp-Central" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Origin station, e.g. "Brussels-South"' },
        to: { type: 'string', description: 'Destination station, e.g. "Antwerp-Central"' },
        depart_at: {
          type: 'string',
          description:
            'Depart at/after this time — "YYYY-MM-DDTHH:MM" or "HH:MM" (today), Belgian local time. Default: now',
        },
        arrive_by: {
          type: 'string',
          description: 'Arrive by this time instead — same formats as depart_at. Overrides depart_at',
        },
        limit: { type: 'number', description: 'Max connections to return, 1-6 (default 4)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'irail_train',
    description:
      'Track one Belgian train by its number — is my Belgian train delayed. All stops with scheduled vs actual times, per-stop delay in minutes, platforms, current delay, and live position. Accepts "IC 1832", "IC1832", or "BE.NMBS.IC1832". Train numbers come from irail_liveboard or irail_journey. Example: irail_train({ id: "IC1832" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'Train id, e.g. "IC1832", "IC 538", "S52558", "EUR9381", or "BE.NMBS.IC1832"',
        },
        date: {
          type: 'string',
          description: 'Optional travel date "YYYY-MM-DD" (default today, Belgian time)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'irail_disturbances',
    description:
      'Current disturbances, incidents, and planned works on the Belgian rail network (SNCB NMBS Infrabel) — strikes, track works, line closures affecting Belgian train service. Returns title, summary, type (planned or disturbance), link, and last-updated time. Example: irail_disturbances({})',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max disturbances to return, 1-50 (default 15)' },
      },
      required: [],
    },
  },
];

// ── helpers ─────────────────────────────────────────────────────────

/** Major-city aliases → main station. iRail's fuzzy match is greedy
 *  ("antwerp" → Antwerp-Haven, "gent" → Gentbrugge), so bare city names
 *  are pointed at the station travelers almost always mean. */
const STATION_ALIASES: Record<string, string> = {
  antwerp: 'Antwerp-Central',
  antwerpen: 'Antwerp-Central',
  anvers: 'Antwerp-Central',
  brussels: 'Brussels-Central',
  brussel: 'Brussels-Central',
  bruxelles: 'Brussels-Central',
  'brussels midi': 'Brussels-South',
  'brussels airport': 'Brussels Airport - Zaventem',
  zaventem: 'Brussels Airport - Zaventem',
  ghent: 'Ghent-Sint-Pieters',
  gent: 'Ghent-Sint-Pieters',
  gand: 'Ghent-Sint-Pieters',
  brugge: 'Bruges',
  liege: 'Liège-Guillemins',
  liège: 'Liège-Guillemins',
  luik: 'Liège-Guillemins',
  charleroi: 'Charleroi-Central',
  namen: 'Namur',
  louvain: 'Leuven',
  malines: 'Mechelen',
  oostende: 'Ostend',
  courtrai: 'Kortrijk',
};

function resolveStation(input: unknown, argName: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new Error(
      `iRail: the \`${argName}\` argument is required — a Belgian station name, e.g. "Brussels-South", "Antwerp-Central", "Ghent-Sint-Pieters".`,
    );
  }
  const key = raw.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return STATION_ALIASES[key] ?? raw;
}

const STATION_HINT =
  'Station unrecognized. Use the official station name — English exonyms work: "Brussels-South", "Brussels-Central", "Antwerp-Central", "Ghent-Sint-Pieters", "Liège-Guillemins", "Bruges", "Leuven". Partial names can match the wrong station (e.g. "antwerp" alone is Antwerp-Haven), so prefer the full name.';

/** Unix-epoch string/number → "YYYY-MM-DDTHH:MM" in Europe/Brussels. */
function toBrusselsIso(unix: string | number | undefined | null): string | null {
  const n = Number(unix);
  if (!n || !Number.isFinite(n)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Brussels',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(n * 1000));
  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Delay seconds (string) → whole minutes. */
function delayMinutes(seconds: string | number | undefined): number {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 60) : 0;
}

function isTrue(flag: string | number | undefined): boolean {
  return flag === '1' || flag === 1;
}

/** Parse "YYYY-MM-DDTHH:MM", "YYYY-MM-DD HH:MM", or "HH:MM" (Belgian local)
 *  into the API's { date: DDMMYY, time: HHMM }. */
function parseWhen(input: string, argName: string): { date?: string; time: string } {
  const s = input.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (m) {
    return { date: `${m[3]}${m[2]}${m[1].slice(2)}`, time: `${m[4].padStart(2, '0')}${m[5]}` };
  }
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    return { time: `${m[1].padStart(2, '0')}${m[2]}` };
  }
  throw new Error(
    `iRail: could not parse \`${argName}\` value "${input}". Use "YYYY-MM-DDTHH:MM" (e.g. "2026-07-20T09:00") or "HH:MM" for today, Belgian local time.`,
  );
}

async function api(path: string, params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams({ ...params, format: 'json', lang: 'en' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    // iRail 303-redirects every request to a versioned path; Workers fetch
    // follows redirects by default — keep it that way.
    res = await fetch(`${BASE_URL}${path}?${qs}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `iRail: request timed out after ${TIMEOUT_MS / 1000}s. The API may be briefly overloaded — retry once.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { exception?: string; message?: string };
      if (body.message) message = body.message;
      if (body.exception === 'RequestedStopNotFoundException') {
        throw new Error(`iRail: ${message}. ${STATION_HINT}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('iRail:')) throw err;
    }
    throw new Error(`iRail ${path} error: ${message}`);
  }
  return res.json();
}

// ── response shapes (only the fields we read) ───────────────────────

interface StationInfo {
  name?: string;
  standardname?: string;
  id?: string;
}

interface VehicleInfo {
  shortname?: string;
  name?: string;
  type?: string;
  number?: string;
  locationX?: string;
  locationY?: string;
}

interface PlatformInfo {
  name?: string;
  normal?: string;
}

interface BoardEntry {
  station?: string;
  stationinfo?: StationInfo;
  time?: string;
  delay?: string;
  canceled?: string;
  left?: string;
  vehicle?: string;
  vehicleinfo?: VehicleInfo;
  platform?: string;
  platforminfo?: PlatformInfo;
  occupancy?: { name?: string };
}

interface ConnectionEnd {
  station?: string;
  stationinfo?: StationInfo;
  time?: string;
  delay?: string;
  canceled?: string;
  vehicle?: string;
  vehicleinfo?: VehicleInfo;
  platform?: string;
  platforminfo?: PlatformInfo;
  direction?: { name?: string };
  walking?: string;
}

interface Via {
  station?: string;
  stationinfo?: StationInfo;
  arrival?: ConnectionEnd;
  departure?: ConnectionEnd;
  timebetween?: string;
}

interface Connection {
  departure?: ConnectionEnd;
  arrival?: ConnectionEnd;
  duration?: string;
  vias?: { number?: string; via?: Via[] };
  alerts?: { number?: string; alert?: Array<{ header?: string; description?: string }> };
  remarks?: { number?: string; remark?: Array<{ description?: string }> };
}

interface VehicleStop {
  station?: string;
  stationinfo?: StationInfo;
  scheduledArrivalTime?: string;
  scheduledDepartureTime?: string;
  arrivalDelay?: string;
  departureDelay?: string;
  delay?: string;
  canceled?: string;
  arrivalCanceled?: string;
  departureCanceled?: string;
  left?: string;
  arrived?: string;
  platform?: string;
  platforminfo?: PlatformInfo;
  occupancy?: { name?: string };
}

interface Disturbance {
  title?: string;
  description?: string;
  type?: string;
  link?: string;
  timestamp?: string;
}

// ── shapers ─────────────────────────────────────────────────────────

function trainName(v?: VehicleInfo, fallback?: string): string | undefined {
  return v?.shortname ?? fallback?.replace(/^BE\.NMBS\./, '');
}

function cleanPlatform(platform?: string): string | null {
  return platform && platform !== '?' ? platform : null;
}

function shapeBoardEntry(e: BoardEntry, direction: 'destination' | 'origin') {
  return {
    train: trainName(e.vehicleinfo, e.vehicle),
    train_type: e.vehicleinfo?.type,
    [direction]: e.station ?? e.stationinfo?.name,
    scheduled_time: toBrusselsIso(e.time),
    delay_minutes: delayMinutes(e.delay),
    platform: cleanPlatform(e.platform),
    platform_changed: e.platforminfo ? !isTrue(e.platforminfo.normal) : undefined,
    canceled: isTrue(e.canceled),
    left: isTrue(e.left),
    occupancy: e.occupancy?.name !== 'unknown' ? e.occupancy?.name : undefined,
  };
}

function shapeLeg(end: ConnectionEnd | undefined, kind: 'departure' | 'arrival') {
  if (!end) return null;
  return {
    station: end.station ?? end.stationinfo?.name,
    scheduled_time: toBrusselsIso(end.time),
    delay_minutes: delayMinutes(end.delay),
    platform: cleanPlatform(end.platform),
    platform_changed: end.platforminfo ? !isTrue(end.platforminfo.normal) : undefined,
    canceled: isTrue(end.canceled),
    train: trainName(end.vehicleinfo, end.vehicle),
    train_type: end.vehicleinfo?.type,
    direction: kind === 'departure' ? end.direction?.name : undefined,
  };
}

function shapeConnection(c: Connection) {
  const vias = c.vias?.via ?? [];
  return {
    departure: shapeLeg(c.departure, 'departure'),
    arrival: shapeLeg(c.arrival, 'arrival'),
    duration_minutes: Math.round(Number(c.duration ?? 0) / 60),
    transfers: vias.length,
    via: vias.map((v) => ({
      station: v.station ?? v.stationinfo?.name,
      arrive: {
        train: trainName(v.arrival?.vehicleinfo, v.arrival?.vehicle),
        scheduled_time: toBrusselsIso(v.arrival?.time),
        delay_minutes: delayMinutes(v.arrival?.delay),
        platform: cleanPlatform(v.arrival?.platform),
      },
      depart: {
        train: trainName(v.departure?.vehicleinfo, v.departure?.vehicle),
        scheduled_time: toBrusselsIso(v.departure?.time),
        delay_minutes: delayMinutes(v.departure?.delay),
        platform: cleanPlatform(v.departure?.platform),
      },
      transfer_minutes: v.timebetween ? Math.round(Number(v.timebetween) / 60) : undefined,
    })),
    alerts: (c.alerts?.alert ?? [])
      .map((a) => (a.header ?? a.description ?? '').slice(0, 200))
      .filter(Boolean),
  };
}

// ── tool implementations ────────────────────────────────────────────

function clampLimit(value: unknown, def: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : def;
}

async function liveboard(args: Record<string, unknown>) {
  const station = resolveStation(args.station, 'station');
  const type = String(args.type ?? 'departure').toLowerCase().startsWith('arr') ? 'arrival' : 'departure';
  const limit = clampLimit(args.limit, 15, 50);
  const data = (await api('/liveboard/', { station, arrdep: type })) as {
    station?: string;
    stationinfo?: StationInfo;
    departures?: { departure?: BoardEntry[] };
    arrivals?: { arrival?: BoardEntry[] };
  };
  const entries = type === 'arrival' ? data.arrivals?.arrival ?? [] : data.departures?.departure ?? [];
  return {
    station: data.station ?? station,
    station_local_name: data.stationinfo?.standardname,
    board_type: type,
    timezone: 'Europe/Brussels',
    count: Math.min(entries.length, limit),
    total_on_board: entries.length,
    [type === 'arrival' ? 'arrivals' : 'departures']: entries
      .slice(0, limit)
      .map((e) => shapeBoardEntry(e, type === 'arrival' ? 'origin' : 'destination')),
  };
}

async function journey(args: Record<string, unknown>) {
  const from = resolveStation(args.from, 'from');
  const to = resolveStation(args.to, 'to');
  const limit = clampLimit(args.limit, 4, 6);
  const params: Record<string, string> = { from, to };
  const arriveBy = args.arrive_by != null && String(args.arrive_by).trim() !== '';
  const whenRaw = arriveBy ? String(args.arrive_by) : args.depart_at != null ? String(args.depart_at) : '';
  if (whenRaw.trim()) {
    const when = parseWhen(whenRaw, arriveBy ? 'arrive_by' : 'depart_at');
    params.time = when.time;
    if (when.date) params.date = when.date;
    params.timesel = arriveBy ? 'arrival' : 'departure';
  }
  const data = (await api('/connections/', params)) as { connection?: Connection[] };
  const connections = data.connection ?? [];
  return {
    from,
    to,
    timesel: params.timesel ?? 'departure',
    timezone: 'Europe/Brussels',
    count: Math.min(connections.length, limit),
    connections: connections.slice(0, limit).map(shapeConnection),
  };
}

async function train(args: Record<string, unknown>) {
  const raw = String(args.id ?? '').trim();
  if (!raw) {
    throw new Error(
      'iRail: the `id` argument is required — a train number like "IC1832" (from irail_liveboard or irail_journey).',
    );
  }
  // Normalize "BE.NMBS.IC1832", "IC 1832", "ic1832" → "IC1832"
  const id = raw.replace(/^BE\.NMBS\./i, '').replace(/\s+/g, '').toUpperCase();
  const params: Record<string, string> = { id };
  const dateRaw = String(args.date ?? '').trim();
  if (dateRaw) {
    const m = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error(`iRail: could not parse \`date\` value "${dateRaw}". Use "YYYY-MM-DD".`);
    params.date = `${m[3]}${m[2]}${m[1].slice(2)}`;
  }
  const data = (await api('/vehicle/', params)) as {
    vehicle?: string;
    vehicleinfo?: VehicleInfo;
    stops?: { stop?: VehicleStop[] };
  };
  const stops = data.stops?.stop ?? [];
  const passed = stops.filter((s) => isTrue(s.left) || isTrue(s.arrived));
  const last = passed[passed.length - 1];
  const currentDelay = last
    ? delayMinutes(last.delay ?? last.departureDelay)
    : delayMinutes(stops[0]?.delay ?? stops[0]?.departureDelay);
  const lat = Number(data.vehicleinfo?.locationY);
  const lon = Number(data.vehicleinfo?.locationX);
  return {
    train: trainName(data.vehicleinfo, data.vehicle),
    train_type: data.vehicleinfo?.type,
    timezone: 'Europe/Brussels',
    current_delay_minutes: currentDelay,
    position: lat && lon ? { latitude: lat, longitude: lon } : undefined,
    stop_count: stops.length,
    stops: stops.map((s) => ({
      station: s.station ?? s.stationinfo?.name,
      scheduled_arrival: toBrusselsIso(s.scheduledArrivalTime),
      scheduled_departure: toBrusselsIso(s.scheduledDepartureTime),
      arrival_delay_minutes: delayMinutes(s.arrivalDelay),
      departure_delay_minutes: delayMinutes(s.departureDelay),
      platform: cleanPlatform(s.platform),
      canceled: isTrue(s.canceled) || (isTrue(s.arrivalCanceled) && isTrue(s.departureCanceled)),
      passed: isTrue(s.left),
      occupancy: s.occupancy?.name !== 'unknown' ? s.occupancy?.name : undefined,
    })),
  };
}

async function disturbances(args: Record<string, unknown>) {
  const limit = clampLimit(args.limit, 15, 50);
  const data = (await api('/disturbances/', {})) as { disturbance?: Disturbance[] };
  const items = data.disturbance ?? [];
  return {
    count: Math.min(items.length, limit),
    total: items.length,
    timezone: 'Europe/Brussels',
    disturbances: items.slice(0, limit).map((d) => ({
      title: d.title,
      description:
        d.description && d.description.length > 300 ? `${d.description.slice(0, 300)}…` : d.description,
      type: d.type,
      link: d.link,
      updated: toBrusselsIso(d.timestamp),
    })),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'irail_liveboard':
      return liveboard(args);
    case 'irail_journey':
      return journey(args);
    case 'irail_train':
      return train(args);
    case 'irail_disturbances':
      return disturbances(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
