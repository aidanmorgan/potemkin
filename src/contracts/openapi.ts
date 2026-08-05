/** Source-neutral OpenAPI operation metadata needed by authoring and generation. */
export interface OpenApiOperationDescriptor {
  readonly operationId?: string;
}

/** Minimal OpenAPI document view shared across authoring and generation ports. */
export interface OpenApiDocumentDescriptor {
  readonly paths: Record<string, Readonly<Record<string, OpenApiOperationDescriptor | undefined>>>;
}
