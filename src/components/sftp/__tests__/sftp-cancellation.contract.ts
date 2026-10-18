import type { JSONSchemaType } from 'ajv';

export interface SftpCancellationConfig {
  port: number;
  switchPort: number;
  switchFingerprint: string;
  password: string;
  fingerprint: string;
  downloadDirectory: string;
  inputDirectory: string;
  largeA: string;
  raceA: string;
  raceB: string;
  smallB: string;
  smallC: string;
}

export const configSchema: JSONSchemaType<SftpCancellationConfig> = {
  type: 'object',
  properties: {
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    switchPort: { type: 'integer', minimum: 1, maximum: 65535 },
    switchFingerprint: { type: 'string', minLength: 1 },
    password: { type: 'string', minLength: 1 },
    fingerprint: { type: 'string', minLength: 1 },
    downloadDirectory: { type: 'string', minLength: 1 },
    inputDirectory: { type: 'string', minLength: 1 },
    largeA: { type: 'string', minLength: 1 },
    raceA: { type: 'string', minLength: 1 },
    raceB: { type: 'string', minLength: 1 },
    smallB: { type: 'string', minLength: 1 },
    smallC: { type: 'string', minLength: 1 },
  },
  required: ['port', 'switchPort', 'switchFingerprint', 'password', 'fingerprint', 'downloadDirectory', 'inputDirectory', 'largeA', 'raceA', 'raceB', 'smallB', 'smallC'],
  additionalProperties: false,
};
