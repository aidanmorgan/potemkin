/** Source-neutral response-policy contracts shared by YAML and HTTP adapters. */

export interface HateoasEntry {
  readonly rel: string;
  readonly href: string;
}

export interface DeprecationConfig {
  readonly date: string;
  readonly sunset?: string;
  readonly replacement?: string;
}

export interface ResponseDeprecation {
  readonly date?: string;
  readonly sunset?: string;
  readonly replacement?: string;
}

export interface SecurityHeadersConfig {
  readonly enabled?: boolean;
  readonly hsts?: boolean;
  readonly nosniff?: boolean;
  readonly frame_deny?: boolean;
  readonly referrer_policy?: string;
  readonly custom_headers?: Record<string, string>;
}

export interface ResponseMutationBoundary {
  readonly hateoas?: readonly HateoasEntry[];
  readonly mask?: readonly string[];
  readonly deprecated?: DeprecationConfig;
}
