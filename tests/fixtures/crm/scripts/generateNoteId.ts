export default function(ctx: { command: any; state: any; event: any; payload: any; helpers: any; logger: any }) {
  return ctx.helpers.uuid();
}
