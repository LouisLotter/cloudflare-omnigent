// G2 sitting: the replica bucket's holder (wrangler.jsonc). It serves nothing.
export default {
  fetch: () => new Response("not found", { status: 404 }),
} satisfies ExportedHandler;
