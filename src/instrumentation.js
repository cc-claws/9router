export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // register() can run before Next loads the .env files (notably under the
    // standalone custom server), which silently hides LANGFUSE_* from the gate
    // below. Load them explicitly — loadEnvConfig is idempotent.
    try {
      const { loadEnvConfig } = await import("@next/env");
      loadEnvConfig(process.cwd(), false);
    } catch { /* fail-open */ }

    // Langfuse tracing (optional). Must init before any request handling so the
    // OTel context propagator is in place; gated so the gateway boots identically
    // when observability export is off.
    if (String(process.env.LANGFUSE_ENABLED || "").toLowerCase() === "true") {
      try {
        const { NodeSDK } = await import("@opentelemetry/sdk-node");
        const { LangfuseSpanProcessor } = await import("@langfuse/otel");
        const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
        sdk.start();
        process.env.NINEROUTER_LANGFUSE_OTEL = "1";
        // The SDK reads LANGFUSE_BASE_URL (region-specific: EU default, or
        // us./jp.cloud.langfuse.com). Wrong region ⇒ 401 on ingest.
        console.log("[langfuse] tracing initialized →", process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || "https://cloud.langfuse.com");
        const stop = () => { try { sdk.shutdown(); } catch { /* ignore */ } };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      } catch (e) {
        console.error("[langfuse] tracing init failed (continuing without it):", e?.message || e);
      }
    }

    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
  }
}
