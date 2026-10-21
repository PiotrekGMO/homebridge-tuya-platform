import { TuyaDeviceSchema, TuyaDeviceSchemaMode, TuyaDeviceSchemaType } from './TuyaDevice';

/**
 * Things Data Model (`/v2.0/cloud/thing/{id}/model`): what the cloud knows about products that have
 * no standard instruction set (`/specifications` answers 2009 "not support this device").
 * `abilityId` is the data point id used by the local protocol.
 */
export interface ThingModelProperty {
  abilityId: number;
  code: string;
  accessMode?: string; // ro | rw | wr
  typeSpec?: {
    type: string; // bool | value | enum | string | raw | bitmap | date
    min?: number;
    max?: number;
    step?: number;
    scale?: number;
    unit?: string;
    range?: string[];
  };
}

const ACCESS_MODES: Record<string, TuyaDeviceSchemaMode> = {
  rw: TuyaDeviceSchemaMode.READ_WRITE,
  ro: TuyaDeviceSchemaMode.READ_ONLY,
  wr: TuyaDeviceSchemaMode.WRITE_ONLY,
};

/** Raw, bitmap and date properties cannot be used by the accessories, they are skipped. */
export function thingPropertyToSchema(property: ThingModelProperty): TuyaDeviceSchema | undefined {
  const spec = property.typeSpec;
  if (!property.code || !spec) {
    return undefined;
  }

  const base = {
    code: property.code,
    dp_id: typeof property.abilityId === 'number' ? property.abilityId : undefined,
    mode: ACCESS_MODES[property.accessMode ?? 'rw'] ?? TuyaDeviceSchemaMode.READ_WRITE,
  };
  if (base.dp_id === undefined) {
    delete base.dp_id;
  }

  switch (spec.type) {
    case 'bool':
      return { ...base, type: TuyaDeviceSchemaType.Boolean, property: {} };
    case 'value':
      return {
        ...base,
        type: TuyaDeviceSchemaType.Integer,
        property: {
          min: spec.min ?? 0,
          max: spec.max ?? 0,
          scale: spec.scale ?? 0,
          step: spec.step ?? 1,
          unit: spec.unit ?? '',
        },
      };
    case 'enum':
      return { ...base, type: TuyaDeviceSchemaType.Enum, property: { range: spec.range ?? [] } };
    case 'string':
      return { ...base, type: TuyaDeviceSchemaType.String, property: {} };
    default:
      return undefined;
  }
}

export function parseThingModel(result: unknown): TuyaDeviceSchema[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (result as any)?.model;
  const model = typeof raw === 'string' ? JSON.parse(raw) : raw;

  const schemas = new Map<string, TuyaDeviceSchema>();
  for (const service of model?.services ?? []) {
    for (const property of service.properties ?? []) {
      const schema = thingPropertyToSchema(property);
      if (schema && !schemas.has(schema.code)) {
        schemas.set(schema.code, schema);
      }
    }
  }
  return [...schemas.values()].sort((a, b) => a.code > b.code ? 1 : -1);
}
