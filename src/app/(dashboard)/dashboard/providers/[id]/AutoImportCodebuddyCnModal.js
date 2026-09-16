"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Modal, Badge } from "@/shared/components";
import { translate } from "@/i18n/runtime";

export default function AutoImportCodebuddyCnModal({
  isOpen,
  onClose,
  onSuccess,
  onFallbackOAuth,
}) {
  const [detecting, setDetecting] = useState(false);
  const [detectedData, setDetectedData] = useState(null);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [error, setError] = useState("");

  // Manual paste tab/mode
  const [mode, setMode] = useState("auto"); // "auto" | "manual"
  const [manualJson, setManualJson] = useState("");

  const runAutoDetect = async () => {
    setDetecting(true);
    setError("");
    setDetectedData(null);
    setImportResult(null);

    try {
      const res = await fetch("/api/oauth/codebuddy-cn/auto-import");
      const data = await res.json();
      if (data.found && Array.isArray(data.accounts) && data.accounts.length > 0) {
        setDetectedData(data);
        // Default select all accounts
        const allIndices = new Set(data.accounts.map((_, i) => i));
        setSelectedIndices(allIndices);
      } else {
        setDetectedData(data);
        if (!data.found) {
          setError(
            data.error ||
              translate("No accounts.json found in ~/.wb-switch/ or ~/.workbuddy/")
          );
        }
      }
    } catch (err) {
      setError(err.message || translate("Failed to detect local accounts"));
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setMode("auto");
    setImportResult(null);
    setError("");
    runAutoDetect();
  }, [isOpen]);

  const handleToggleAccount = (index) => {
    const next = new Set(selectedIndices);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    setSelectedIndices(next);
  };

  const handleSelectAll = () => {
    if (!detectedData?.accounts) return;
    if (selectedIndices.size === detectedData.accounts.length) {
      setSelectedIndices(new Set());
    } else {
      setSelectedIndices(new Set(detectedData.accounts.map((_, i) => i)));
    }
  };

  const handleImportSelected = async () => {
    if (!detectedData?.accounts || selectedIndices.size === 0) return;
    setImporting(true);
    setError("");
    setImportResult(null);

    const accountsToImport = detectedData.accounts.filter((_, i) =>
      selectedIndices.has(i)
    );

    try {
      const res = await fetch("/api/oauth/codebuddy-cn/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: accountsToImport }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `Import failed: ${res.status}`);
        return;
      }
      setImportResult(data);
      if (data.success > 0 && typeof onSuccess === "function") {
        onSuccess();
      }
    } catch (err) {
      setError(err.message || translate("Import failed"));
    } finally {
      setImporting(false);
    }
  };

  const handleManualImport = async () => {
    const trimmed = manualJson.trim();
    if (!trimmed) {
      setError(translate("Please paste JSON content"));
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      setError(`${translate("Invalid JSON")}: ${err.message}`);
      return;
    }

    const accounts = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.accounts)
        ? parsed.accounts
        : [parsed];

    setImporting(true);
    setError("");
    setImportResult(null);

    try {
      const res = await fetch("/api/oauth/codebuddy-cn/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `Import failed: ${res.status}`);
        return;
      }
      setImportResult(data);
      if (data.success > 0 && typeof onSuccess === "function") {
        onSuccess();
      }
    } catch (err) {
      setError(err.message || translate("Import failed"));
    } finally {
      setImporting(false);
    }
  };

  const formatDate = (val) => {
    if (!val) return "Unknown";
    try {
      const d = typeof val === "number" ? new Date(val) : new Date(val);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return String(val);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!importing) onClose();
      }}
      title={translate("Import Accounts from WorkBuddy (wb-switch)")}
      size="lg"
    >
      <div className="space-y-4">
        {/* Tab switch */}
        <div className="flex border-b border-gray-200 dark:border-gray-700">
          <button
            type="button"
            className={`pb-2 px-3 text-sm font-medium border-b-2 transition-colors ${
              mode === "auto"
                ? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400"
            }`}
            onClick={() => {
              setMode("auto");
              setError("");
            }}
          >
            {translate("Auto Detect (Local)")}
          </button>
          <button
            type="button"
            className={`pb-2 px-3 text-sm font-medium border-b-2 transition-colors ${
              mode === "manual"
                ? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400"
            }`}
            onClick={() => {
              setMode("manual");
              setError("");
            }}
          >
            {translate("Paste JSON")}
          </button>
        </div>

        {error && (
          <div className="p-3 text-sm text-red-700 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded-lg">
            {error}
          </div>
        )}

        {/* Result summary banner */}
        {importResult && (
          <div className="p-3 text-sm bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
            <div className="font-semibold text-green-800 dark:text-green-300">
              {translate("Import completed")}: {importResult.success}{" "}
              {translate("succeeded")},{" "}
              {importResult.failed} {translate("failed")}
            </div>
            {importResult.results && importResult.results.length > 0 && (
              <div className="mt-2 space-y-1 text-xs text-green-700 dark:text-green-400">
                {importResult.results.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className={r.status === "fulfilled" ? "text-green-600" : "text-red-500"}>
                      {r.status === "fulfilled" ? "✓" : "✗"}
                    </span>
                    <span>{r.name || `Account ${i + 1}`}</span>
                    {r.updated && (
                      <span className="text-gray-400">({translate("updated existing")})</span>
                    )}
                    {r.error && <span className="text-red-500">({r.error})</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Mode: Auto Detect */}
        {mode === "auto" && (
          <div>
            {detecting ? (
              <div className="py-8 text-center text-sm text-gray-500">
                <span className="inline-block animate-spin mr-2">⟳</span>
                {translate("Detecting local WorkBuddy credentials...")}
              </div>
            ) : detectedData?.found && detectedData.accounts?.length > 0 ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>
                    {translate("Detected from")}:{" "}
                    <code className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded font-mono">
                      {detectedData.path}
                    </code>
                  </span>
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    className="text-blue-600 hover:underline"
                  >
                    {selectedIndices.size === detectedData.accounts.length
                      ? translate("Deselect All")
                      : translate("Select All")}
                  </button>
                </div>

                <div className="max-h-64 overflow-y-auto space-y-2 border border-gray-200 dark:border-gray-700 rounded-lg p-2">
                  {detectedData.accounts.map((acc, index) => {
                    const isSelected = selectedIndices.has(index);
                    return (
                      <div
                        key={index}
                        onClick={() => handleToggleAccount(index)}
                        className={`flex items-center justify-between p-2.5 rounded border cursor-pointer transition-colors ${
                          isSelected
                            ? "border-blue-500 bg-blue-50/50 dark:bg-blue-900/20"
                            : "border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}} // Handled by parent div
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm text-gray-900 dark:text-gray-100">
                                {acc.nickname || acc.phoneNumber || `Account ${index + 1}`}
                              </span>
                              {acc.phoneNumber && acc.nickname !== acc.phoneNumber && (
                                <span className="text-xs text-gray-500">
                                  ({acc.phoneNumber})
                                </span>
                              )}
                              {acc.isImported ? (
                                <Badge variant="warning" size="xs">
                                  {translate("Already in 9Router")}
                                </Badge>
                              ) : (
                                <Badge variant="success" size="xs">
                                  {translate("New")}
                                </Badge>
                              )}
                            </div>
                            <div className="text-xs text-gray-400 mt-0.5">
                              UID: {acc.uid?.slice(0, 16)}... | Expires:{" "}
                              {formatDate(acc.expiresAt)}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-gray-500">
                    {translate("Selected")}: {selectedIndices.size} /{" "}
                    {detectedData.accounts.length}
                  </span>
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={runAutoDetect}>
                      {translate("Refresh")}
                    </Button>
                    <Button
                      variant="primary"
                      onClick={handleImportSelected}
                      disabled={importing || selectedIndices.size === 0}
                    >
                      {importing
                        ? translate("Importing...")
                        : translate("Import Selected Accounts")}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-6 text-center space-y-3">
                <div className="text-sm text-gray-500">
                  {translate("No accounts found in local directory (~/.wb-switch/accounts.json).")}
                </div>
                <div className="flex justify-center gap-2">
                  <Button variant="outline" size="sm" onClick={runAutoDetect}>
                    {translate("Retry Detection")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setMode("manual")}
                  >
                    {translate("Paste JSON Instead")}
                  </Button>
                  {typeof onFallbackOAuth === "function" && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        onClose();
                        onFallbackOAuth();
                      }}
                    >
                      {translate("Browser OAuth Login")}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Mode: Manual JSON Paste */}
        {mode === "manual" && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              {translate("Paste content of accounts.json or an array of account objects with accessToken / refreshToken:")}
            </p>
            <textarea
              rows={8}
              value={manualJson}
              onChange={(e) => setManualJson(e.target.value)}
              placeholder={`[\n  {\n    "access_token": "eyJhbGc...",\n    "refresh_token": "...",\n    "nickname": "WorkBuddy 1"\n  }\n]`}
              className="w-full font-mono text-xs p-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {translate("Cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={handleManualImport}
                disabled={importing || !manualJson.trim()}
              >
                {importing ? translate("Importing...") : translate("Import JSON")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

AutoImportCodebuddyCnModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
  onFallbackOAuth: PropTypes.func,
};
