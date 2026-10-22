import { TuyaDeviceSchema, TuyaDeviceSchemaType, TuyaDeviceStatus } from './TuyaDevice';

/**
 * The cloud shows some data points as JSON, the device keeps them in a compact form. The accessories
 * work with the cloud form, so values are translated when they come over LAN and when they go back.
 *
 * `colour_data`: cloud `{"h":220,"s":1000,"v":1000}`, device `HHHHSSSSVVVV` (12 hex digits, s and v up to 1000)
 * or, for the older 0-255 variant, `RRGGBBHHHHSSVV` (14 hex digits).
 */
const HEX = /^[0-9a-fA-F]+$/;

function isColour(schema: TuyaDeviceSchema) {
  return schema.type === TuyaDeviceSchemaType.Json && schema.code.startsWith('colour_data');
}

export function decodeLocalValue(schema: TuyaDeviceSchema, value: TuyaDeviceStatus['value']): TuyaDeviceStatus['value'] {
  if (!isColour(schema) || typeof value !== 'string' || !HEX.test(value)) {
    return value; // not a colour data point, or already the cloud form
  }

  if (value.length === 12) {
    return JSON.stringify({
      h: parseInt(value.slice(0, 4), 16),
      s: parseInt(value.slice(4, 8), 16),
      v: parseInt(value.slice(8, 12), 16),
    });
  }
  if (value.length === 14) {
    return JSON.stringify({
      h: parseInt(value.slice(6, 10), 16),
      s: parseInt(value.slice(10, 12), 16),
      v: parseInt(value.slice(12, 14), 16),
    });
  }
  return value;
}

function hex(value: number, digits: number) {
  return Math.max(0, Math.round(value)).toString(16).padStart(digits, '0').slice(-digits);
}

function hsvToRgb(h: number, s: number, v: number) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m].map(channel => Math.round(channel * 255));
}

export function encodeLocalValue(schema: TuyaDeviceSchema, value: TuyaDeviceStatus['value'] | object): unknown {
  if (!isColour(schema)) {
    return value;
  }

  let colour = value as { h?: unknown; s?: unknown; v?: unknown } | string;
  if (typeof colour === 'string') {
    try {
      colour = JSON.parse(colour);
    } catch (error) {
      return value; // already in the device form
    }
  }
  const { h, s, v } = (colour ?? {}) as { h?: number; s?: number; v?: number };
  if (typeof h !== 'number' || typeof s !== 'number' || typeof v !== 'number') {
    return value;
  }

  const property = schema.property as { s?: { max?: number }; v?: { max?: number } };
  const sMax = property?.s?.max ?? 1000;
  const vMax = property?.v?.max ?? 1000;
  if (sMax > 255) {
    return hex(h, 4) + hex(s, 4) + hex(v, 4);
  }
  const [r, g, b] = hsvToRgb(h, s / sMax, v / vMax);
  return hex(r, 2) + hex(g, 2) + hex(b, 2) + hex(h, 4) + hex(s, 2) + hex(v, 2);
}
