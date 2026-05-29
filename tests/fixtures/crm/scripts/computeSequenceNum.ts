export default function(ctx: { command: any; state: any; event: any; payload: any; helpers: any; logger: any }) {
  const existing = ctx.state?.transcript ?? [];
  return existing.length + 1;
}
