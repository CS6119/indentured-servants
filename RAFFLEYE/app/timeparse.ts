import type { TimeKey } from './models.js';
import { cityMapping } from 'city-timezones';
import { Temporal } from '@js-temporal/polyfill';

export interface ExplicitTime { text: string; epoch: number; inferredZone?: string }
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const zone = String.raw`(?:JST|KST|Z|(?:UTC|GMT)(?:\s*[+-]\d{1,2}(?::?\d{2})?)?|[+-]\d{2}:?\d{2})`;
const time = String.raw`(?<hour>\d{1,2})(?::(?<minute>\d{2}))?(?::(?<second>\d{2}))?\s*(?<ampm>AM|PM)?`;
const tail = String.raw`(?:\s+at|\s*,)?[T\s]+${time}\s*\(?(?<zone>${zone})(?![\w:+-])\)?`;
const monthNames = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const numericDate = String.raw`(?<![\d/.-])(?<first>\d{1,2})(?<sep>[/.-])(?<last>\d{1,2})\k<sep>(?<year>\d{4})(?!\d)`;
const datePatterns = [
  String.raw`(?<!\d)(?<year>\d{4})(?<sep>[-/.])(?<month>\d{1,2})\k<sep>(?<day>\d{1,2})${tail}`,
  String.raw`(?<month_name>${monthNames})\s+(?<day>\d{1,2})(?:st|nd|rd|th)?[,]?\s+(?<year>\d{4})${tail}`,
  String.raw`(?<!\d)(?<day>\d{1,2})(?:st|nd|rd|th)?\s+(?<month_name>${monthNames})[,]?\s+(?<year>\d{4})${tail}`,
  numericDate + tail,
];
const labels: Record<TimeKey, string> = {
  starts_at: String.raw`starts?|opens?|begins?|開始`,
  deadline_at: String.raw`ends?|ending|deadline|closes?|until|截止|結束|结束`,
  announcement_at: String.raw`winners?\s+(?:will\s+be\s+)?(?:announced|announcement|drawn|picked|selected)|announcement|公布`,
};
export interface TimeStatement { evidence: string; raw: string }
export function labelledTimes(text: string): Record<TimeKey, TimeStatement[]> {
  const result = { starts_at: [], deadline_at: [], announcement_at: [] } as Record<TimeKey, TimeStatement[]>;
  const nextLabel = String.raw`(?<![A-Za-z])(?:${Object.values(labels).join('|')})(?![A-Za-z])`;
  for (const key of Object.keys(labels) as TimeKey[]) {
    const pattern = new RegExp(String.raw`(?<![A-Za-z])(?:${labels[key]})(?![A-Za-z])(?:\s+(?:on|at|by))?\s*[:：]?\s*([^\n]+?)(?=${nextLabel}|\n|$)`, 'gi');
    result[key] = [...text.matchAll(pattern)].map(match => ({ evidence: match[0], raw: (match[1] ?? '').replace(/^[ \t⋆˙⟡★☆✦─]+|[ \t⋆˙⟡★☆✦─]+$/g, '') }));
  }
  return result;
}
function dateOrders(text: string): Set<'mdy' | 'dmy'> {
  const result = new Set<'mdy' | 'dmy'>();
  if (/\bMM\s*[/.-]\s*DD\s*[/.-]\s*YYYY\b/i.test(text)) result.add('mdy');
  if (/\bDD\s*[/.-]\s*MM\s*[/.-]\s*YYYY\b/i.test(text)) result.add('dmy');
  return result;
}
export function unresolvedTimeReason(text: string, context = ''): string {
  const match = new RegExp(numericDate).exec(text);
  if (match?.groups && !dateOrders(text).size && !dateOrders(context).size) {
    const a = Number(match.groups.first), b = Number(match.groups.last);
    if (a >= 1 && a <= 12 && b >= 1 && b <= 12 && a !== b) return 'MM/DD or DD/MM unclear; UTC unavailable';
  }
  const missing = [];
  if (!/\b\d{4}\b/.test(text)) missing.push('year');
  if (!/\d{1,2}:\d{2}|\d{1,2}\s*(?:AM|PM)\b/i.test(text)) missing.push('time');
  if (!/\b(?:UTC|GMT|JST|KST)\b|\dZ\b|[+-]\d{2}:?\d{2}\b/i.test(text)) missing.push('timezone');
  return missing.length ? `${missing.join('/')} missing; UTC unavailable` : 'date/time unresolved; UTC unavailable';
}
function utcDate(year: number, month: number, day: number, hour: number, minute: number, second: number): number | null {
  if (year < 1 || year > 9999 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime();
}
export function explicitTimes(text: string, context = ''): ExplicitTime[] {
  const results: ExplicitTime[] = [];
  for (const pattern of datePatterns) {
    for (const match of text.matchAll(new RegExp(pattern, 'gi'))) {
      const values = match.groups;
      if (!values) continue;
      const zoneValue = (values.zone ?? '').toUpperCase().replace(/\s/g, '').replace(/^(?:JST|KST)$/, '+09:00').replace(/^(?:UTC|GMT)/, '');
      let offset = 0;
      if (zoneValue !== '' && zoneValue !== 'Z') {
        const sign = zoneValue[0] === '-' ? -1 : 1;
        const digits = zoneValue.slice(1).replace(':', '');
        const hours = Number(digits.length <= 2 ? digits : digits.slice(0, -2));
        const minutes = digits.length <= 2 ? 0 : Number(digits.slice(-2));
        if (hours > 23 || minutes > 59) continue;
        offset = sign * (hours * 60 + minutes) * 60000;
      }
      let hour = Number(values.hour);
      if (values.ampm) {
        if (hour < 1 || hour > 12) continue;
        hour = hour % 12 + (values.ampm.toUpperCase() === 'PM' ? 12 : 0);
      } else if (values.minute === undefined) continue;
      const month = values.month_name ? months.indexOf(values.month_name.slice(0, 3).toLowerCase()) + 1 : Number(values.month ?? 1);
      let pairs: [number, number][] = [[month, Number(values.day)]];
      if (values.first !== undefined) {
        const a = Number(values.first), b = Number(values.last);
        const hints = dateOrders(text).size ? dateOrders(text) : dateOrders(context);
        if (hints.size > 1) continue;
        pairs = hints.has('mdy') ? [[a, b]] : hints.has('dmy') ? [[b, a]] : [[a, b], [b, a]];
      }
      const dates = new Set<number>();
      for (const [m, d] of pairs) {
        const epoch = utcDate(Number(values.year), m, d, hour, Number(values.minute ?? 0), Number(values.second ?? 0));
        if (epoch !== null) dates.add(epoch - offset);
      }
      if (dates.size === 1) results.push({ text: match[0], epoch: [...dates][0]! });
    }
  }
  return results;
}

const normalizeLocation = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const locations = new Map<string, Set<string>>();
for (const city of cityMapping) {
  const countries = [city.country, city.iso2, city.iso3];
  const regions = [city.province, city.state_ansi].filter(Boolean);
  const names = [city.city, city.city_ascii].filter(Boolean);
  const keys = [...countries, ...regions, ...names];
  for (const name of names) {
    for (const region of regions) keys.push(`${name} ${region}`);
    for (const country of countries) {
      keys.push(`${name} ${country}`);
      for (const region of regions) keys.push(`${name} ${region} ${country}`);
    }
  }
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    const normalized = normalizeLocation(key);
    if (!normalized || !city.timezone) continue;
    if (!locations.has(normalized)) locations.set(normalized, new Set());
    locations.get(normalized)!.add(city.timezone);
  }
}
export function locationTimezone(location: string): string | null {
  const aliases: Record<string, string> = { uk: 'united kingdom', 'south korea': 'korea south', '台灣': 'taiwan', '臺灣': 'taiwan', '台北': 'taipei' };
  const input = aliases[location.trim().toLowerCase()] ?? location;
  const matches = locations.get(normalizeLocation(input));
  return matches?.size === 1 ? [...matches][0]! : null;
}
export function resolvedTimes(text: string, context = '', location = ''): ExplicitTime[] {
  const explicit = explicitTimes(text, context);
  if (explicit.length || /\b(?:UTC|GMT|[A-Z]{2,5}ST|[A-Z]{2,5}DT)\b|\dZ\b|[+-]\d{2}:?\d{2}\b/i.test(text)) return explicit;
  const declared = [...context.matchAll(new RegExp(String.raw`(?:all\s+times?\s+(?:(?:are|in)\s+)?|time\s*zone\s*[:：]\s*)(${zone})(?![\w:+-])`, 'gi'))].map(match => match[1]!);
  const declaredZones = [...new Set(declared.map(value => value.toUpperCase().replace(/\s/g, '')))];
  if (declaredZones.length > 1) return [];
  const inferredZone = locationTimezone(location);
  if (!inferredZone && !declaredZones.length) return [];
  const results: ExplicitTime[] = [];
  // Match only a complete date and clock. The synthetic UTC is used to validate date order;
  // Temporal then interprets its wall-clock fields in the profile's IANA timezone.
  const localTail = String.raw`(?:\s+at|\s*,)?[T\s]+${time}(?![:\d])`;
  for (const pattern of datePatterns) {
    for (const match of text.matchAll(new RegExp(pattern.replace(tail, localTail), 'gi'))) {
      // Unknown explicit abbreviations must not silently turn into a location estimate.
      if (/^\s*[A-Za-z]{2,5}\b/.test(text.slice(match.index + match[0].length))) continue;
      if (declaredZones.length) {
        results.push(...explicitTimes(match[0].trimEnd() + ' ' + declaredZones[0], context));
        continue;
      }
      for (const candidate of explicitTimes(match[0].trimEnd() + ' UTC', context)) {
        try {
          const wall = Temporal.PlainDateTime.from(new Date(candidate.epoch).toISOString().replace(/Z$/, ''));
          const epoch = Number(wall.toZonedDateTime(inferredZone!, { disambiguation: 'reject' }).epochMilliseconds);
          results.push({ text: match[0], epoch, inferredZone: inferredZone! });
        } catch { /* DST gaps/folds are not safe to infer. */ }
      }
    }
  }
  return results;
}
export function timezoneNote(evidence: string, context: string, location: string): string {
  const resolved = resolvedTimes(evidence, context, location);
  const inferred = resolved.find(item => item.inferredZone);
  return inferred ? `Estimated from profile location: ${location} (${inferred.inferredZone})` : '';
}
