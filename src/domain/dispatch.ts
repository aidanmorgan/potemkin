export interface DispatchCandidate<Context> {
  readonly operationId: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly condition?: (context: Context) => boolean;
  readonly emitWhen?: readonly { readonly when: (context: Context) => boolean }[];
  readonly requires?: readonly { readonly check: (context: Context) => boolean }[];
}

export interface DispatchRequest<Context> {
  readonly operationId?: string;
  readonly method: string;
  readonly inbound: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly context: Context;
}

export function matchesHeaders(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([name, wanted]) => {
    const value = Object.entries(actual).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    )?.[1];
    return wanted === 'present' || wanted === '*' ? value !== undefined : value === wanted;
  });
}

/** Select the first compiled behavior whose operation and guards match. */
export function selectBehavior<Context, Candidate extends DispatchCandidate<Context>>(
  candidates: readonly Candidate[],
  request: DispatchRequest<Context>,
): Candidate | undefined {
  return candidates.find((candidate) => {
    if (candidate.operationId !== request.operationId) return false;
    if (
      request.inbound &&
      candidate.method !== undefined &&
      candidate.method.toUpperCase() !== request.method.toUpperCase()
    )
      return false;
    if (candidate.headers !== undefined && !matchesHeaders(request.headers, candidate.headers)) {
      return false;
    }
    try {
      if (!(candidate.condition?.(request.context) ?? true)) return false;
      if (
        candidate.emitWhen === undefined ||
        candidate.emitWhen.some((entry) => entry.when(request.context))
      )
        return true;
      return candidate.requires?.some((guard) => !guard.check(request.context)) ?? false;
    } catch {
      return false;
    }
  });
}
