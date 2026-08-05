/** Deterministic data-generation contract shared by authoring and lifecycle hooks. */
export type DataFormat =
  | 'email'
  | 'uuid'
  | 'date'
  | 'date-time'
  | 'uri'
  | 'url'
  | 'hostname'
  | 'ipv4'
  | 'string';

export interface DataGenerator {
  readonly person: Readonly<{
    firstName: () => string;
    lastName: () => string;
    fullName: () => string;
  }>;
  readonly internet: Readonly<{
    email: () => string;
    url: () => string;
    domainName: () => string;
  }>;
  readonly phone: Readonly<{ number: () => string }>;
  readonly company: Readonly<{ name: () => string }>;
  readonly address: Readonly<{
    city: () => string;
    streetAddress: () => string;
  }>;
  readonly fromFormat: (format: DataFormat) => string;
  readonly withRandom: (random: () => number) => DataGenerator;
}
