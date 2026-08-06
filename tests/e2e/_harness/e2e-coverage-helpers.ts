import { requestThroughSpecmatic } from './crm-e2e-helpers';
import type { E2eApp } from './e2e-test-app';

export async function resetE2eApp(app: E2eApp): Promise<void> {
  const response = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
  expect([200, 204]).toContain(response.status);
}

export function emptyBody(body: unknown): boolean {
  return (
    body === null ||
    body === '' ||
    (typeof body === 'object' && body !== null && Object.keys(body).length === 0)
  );
}

export { requestThroughSpecmatic };
