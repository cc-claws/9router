// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
  saveRequestDetail, getRequestDetails, getRequestDetailById,
  createTrace, finalizeTrace, refreshTraceAggregates,
  getTraces, getTraceById, getTraceSpans, getSessions,
  addTraceScore, getTraceScores, deleteTraceScore,
  getPrompts, getPromptById, savePrompt, deletePrompt,
} from "@/lib/db/index.js";
