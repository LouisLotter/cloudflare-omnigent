// The M3 sitting: the holder of the replica's and the artifacts' buckets (wrangler.jsonc). It
// serves nothing.
export default {
  fetch: () => new Response("not found", { status: 404 }),
} satisfies ExportedHandler;
