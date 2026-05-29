export default function(ctx: { command: any; state: any; event: any; payload: any; helpers: any; logger: any }) {
  const source = ctx.command.payload.source;
  const baseScore: Record<string, number> = { REFERRAL: 80, PARTNER: 70, WEBSITE: 50, COLD_LIST: 20 };
  return baseScore[source] ?? 30;
}
