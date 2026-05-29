export default function(ctx: { command: any; state: any; event: any; payload: any; helpers: any; logger: any }) {
  const qty = ctx.command.payload.quantity ?? 0;
  const price = ctx.command.payload.unitPrice ?? 0;
  return qty * price;
}
