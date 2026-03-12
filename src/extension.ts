import * as vscode from "vscode";

/**
 * Represents a single usage limit entry returned by the z.ai quota API.
 */
interface ZaiLimit {
  /** The type identifier of the limit (e.g. `"TOKENS_LIMIT"`). */
  type: string;
  /** The current usage as a decimal percentage (e.g. `0.753` means 75.3 %). */
  percentage: number;
  /** Unix timestamp (ms) at which this limit will reset. */
  nextResetTime: number;
}

/**
 * The top-level response shape returned by the z.ai quota/limit API endpoint.
 */
interface ZaiApiResponse {
  /** Whether the API call succeeded. `false` indicates an application-level error. */
  success?: boolean;
  /** Application-level error code, present when `success` is `false`. */
  code?: number;
  /** Human-readable error message, present when `success` is `false`. */
  msg?: string;
  /** The payload containing the list of quota limits. */
  data: {
    /** Array of per-type quota limit entries. */
    limits: ZaiLimit[];
  };
}

/**
 * The structure persisted to `globalState` for caching API responses.
 */
interface CacheData {
  /** Schema version used to invalidate stale cache entries across extension updates. */
  version: string;
  /** Unix timestamp (ms) at which the cache entry was written. */
  timestamp: number;
  /** The raw API response that was cached. */
  data: ZaiApiResponse;
}

/**
 * Simplified token-usage statistics derived from a {@link ZaiApiResponse}.
 */
interface UsageData {
  /** Rounded token usage percentage (one decimal place, e.g. `75.3`). */
  percentage: number;
  /** Unix timestamp (ms) of the next quota reset, or `null` if unknown. */
  nextResetTime: number | null;
}

/** Schema version embedded in every cache entry; increment to bust old caches. */
const CACHE_VERSION = "1.0";
/** Key used to store the cache object in `vscode.ExtensionContext.globalState`. */
const CACHE_KEY = "zaiUsage.cache";
/** Key used to store the API key in `vscode.ExtensionContext.secrets`. */
const API_KEY_SECRET = "zaiUsage.apiKey";
/** The z.ai quota/limit API endpoint. */
const API_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

/**
 * Activates the extension.
 * @param context - The extension context provided by VSCode.
 */
export function activate(context: vscode.ExtensionContext): void {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = getLabel("...");
  statusBarItem.show();

  let intervalId: ReturnType<typeof setInterval> | undefined;

  /**
   * Returns the polling interval in milliseconds from the workspace configuration.
   * The value is clamped to a minimum of 10 seconds to prevent API flooding.
   *
   * @returns The refresh interval in milliseconds (minimum 10,000 ms).
   */
  function getRefreshInterval(): number {
    const seconds = vscode.workspace
      .getConfiguration("zaiUsage")
      .get<number>("refreshInterval", 60);
    // Clamp to a minimum of 10 seconds to prevent API flooding from invalid config values.
    return Math.max(seconds, 10) * 1000;
  }

  /**
   * Builds the status bar label by prepending the configured prefix to a given suffix.
   * Uses a custom icon when the `useIcon` setting is enabled, otherwise falls back to "z.ai:".
   *
   * @param suffix - The text to append after the prefix (e.g. "75.3% (2h30m)").
   * @returns The fully composed status bar label string.
   */
  function getLabel(suffix: string): string {
    const useIcon = vscode.workspace
      .getConfiguration("zaiUsage")
      .get<boolean>("useIcon", true);
    const prefix = useIcon ? "$(zai-icon)" : "z.ai:";
    return `${prefix} ${suffix}`;
  }

  /**
   * Retrieves the cached API response from the extension's global state.
   * Returns `null` when no cache exists or when the stored cache version does not
   * match the current {@link CACHE_VERSION}.
   *
   * @returns The cached {@link CacheData} object, or `null` if absent or stale.
   */
  function getCache(): CacheData | null {
    const cache = context.globalState.get<CacheData>(CACHE_KEY);
    if (!cache || cache.version !== CACHE_VERSION) {
      return null;
    }
    return cache;
  }

  /**
   * Persists the given API response to the extension's global state as a versioned cache entry.
   * The entry records the current timestamp so that {@link isCacheValid} can later evaluate
   * whether the data is still fresh.
   *
   * @param data - The raw {@link ZaiApiResponse} to store in the cache.
   * @returns `void`
   */
  function setCache(data: ZaiApiResponse): void {
    context.globalState.update(CACHE_KEY, {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      data,
    } satisfies CacheData);
  }

  /**
   * Extracts token-usage statistics from a raw API response.
   * Looks for the `TOKENS_LIMIT` entry inside `data.limits` and maps it to a
   * simplified {@link UsageData} object.
   *
   * @param data - The raw {@link ZaiApiResponse} returned by the z.ai quota API.
   * @returns A {@link UsageData} object containing the usage percentage and next reset
   *   timestamp, or `null` when the expected data structure is absent.
   */
  function extractUsageData(data: ZaiApiResponse): UsageData | null {
    const limits = data.data?.limits;
    if (!Array.isArray(limits)) {
      return null;
    }

    const tokenLimit = limits.find((l) => l.type === "TOKENS_LIMIT");
    if (!tokenLimit) {
      return null;
    }

    return {
      percentage: Math.round(tokenLimit.percentage * 10) / 10,
      nextResetTime: tokenLimit.nextResetTime ?? null,
    };
  }

  /**
   * Determines whether a cached API response is still valid and can be used
   * without issuing a new network request.
   *
   * A cache is considered invalid when any of the following conditions are met:
   * - The cache object is `null`.
   * - The elapsed time since caching exceeds the configured refresh interval.
   * - The `nextResetTime` stored in the cache is in the past, meaning a usage
   *   reset has already occurred and fresh data is required.
   *
   * @param cache - The {@link CacheData} to validate, or `null`.
   * @returns `true` if the cache is fresh and can be used; `false` otherwise.
   */
  function isCacheValid(cache: CacheData | null): boolean {
    if (!cache) {
      return false;
    }
    if (Date.now() - cache.timestamp >= getRefreshInterval()) {
      return false;
    }
    // If nextResetTime stored in the cache is in the past, invalidate and fetch fresh data.
    const usage = extractUsageData(cache.data);
    if (usage?.nextResetTime && usage.nextResetTime <= Date.now()) {
      return false;
    }
    return true;
  }

  /**
   * Formats the time remaining until the next usage quota reset into a short
   * human-readable string such as `"(2h30m)"` or `"(45m)"`.
   *
   * Returns an empty string when `nextResetTime` is falsy, non-positive, or
   * already in the past.
   *
   * @param nextResetTime - The Unix timestamp (in milliseconds) of the next reset,
   *   or `null` if unknown.
   * @returns A formatted countdown string like `"(1h5m)"`, or `""` if not applicable.
   */
  function formatResetTime(nextResetTime: number | null): string {
    if (!nextResetTime || nextResetTime <= 0) {
      return "";
    }
    const diffMs = nextResetTime - Date.now();
    if (diffMs <= 0) {
      return "";
    }
    const diffSec = Math.floor(diffMs / 1000);
    const diffHours = Math.floor(diffSec / 3600);
    const diffMins = Math.floor((diffSec % 3600) / 60);
    const parts: string[] = [];
    if (diffHours > 0) parts.push(`${diffHours}h`);
    parts.push(`${diffMins}m`);
    return `(${parts.join("")})`;
  }

  /**
   * Calls the z.ai quota API with the provided API key and returns the parsed response.
   *
   * Returns `null` on any of the following failure conditions:
   * - A non-2xx HTTP status code is received.
   * - The HTTP 200 response payload contains `success: false` (the API may return
   *   authentication errors with a 200 status, so the payload must be inspected).
   * - A network or parsing error is thrown.
   *
   * @param apiKey - The Bearer token used to authenticate the API request.
   * @returns A promise that resolves to the {@link ZaiApiResponse}, or `null` on failure.
   */
  async function fetchFromApi(apiKey: string): Promise<ZaiApiResponse | null> {
    try {
      const response = await fetch(API_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        console.error(
          "[z.ai Usage] API HTTP error:",
          response.status,
          await response.text(),
        );
        return null;
      }

      const data: ZaiApiResponse = await response.json();

      // The API may return an authentication error within a 200 response — always inspect the payload.
      if (data.success === false) {
        console.error("[z.ai Usage] API error response:", data.code, data.msg);
        return null;
      }

      return data;
    } catch (error) {
      console.error("[z.ai Usage] Error:", error);
      return null;
    }
  }

  /**
   * Orchestrates the full usage-data retrieval flow: secret lookup → cache check →
   * optional API call → stale-cache fallback.
   *
   * Resolution order:
   * 1. If no API key is stored, returns `noApiKey: true` immediately.
   * 2. If a valid cache entry exists, returns the cached data without an API call.
   * 3. Calls the API; on success, writes the response to the cache and returns it.
   * 4. On API failure, falls back to the expired cache if one is available.
   * 5. Returns `usage: null` when all sources are unavailable.
   *
   * @returns A promise resolving to an object with:
   *   - `usage` — The parsed {@link UsageData}, or `null` when unavailable.
   *   - `apiCalled` — `true` when a live API request was made successfully.
   *   - `noApiKey` — `true` when no API key is stored in the secret store.
   */
  async function fetchUsage(): Promise<{
    usage: UsageData | null;
    apiCalled: boolean;
    noApiKey: boolean;
  }> {
    const apiKey = await context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      return { usage: null, apiCalled: false, noApiKey: true };
    }

    const cache = getCache();

    if (cache && isCacheValid(cache)) {
      return {
        usage: extractUsageData(cache.data),
        apiCalled: false,
        noApiKey: false,
      };
    }

    const apiData = await fetchFromApi(apiKey);

    if (apiData) {
      setCache(apiData);
      return {
        usage: extractUsageData(apiData),
        apiCalled: true,
        noApiKey: false,
      };
    }

    // Fall back to the expired cache when the API call fails.
    if (cache) {
      return {
        usage: extractUsageData(cache.data),
        apiCalled: false,
        noApiKey: false,
      };
    }

    return { usage: null, apiCalled: false, noApiKey: false };
  }

  /**
   * Starts (or restarts) the polling interval that periodically calls
   * {@link updateStatusBar}.
   *
   * If a previous interval is already running it is cleared before a new one
   * is created, ensuring that configuration changes (e.g. `refreshInterval`)
   * take effect immediately without spawning duplicate timers.
   *
   * @returns `void`
   */
  function startInterval(): void {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }
    intervalId = setInterval(updateStatusBar, getRefreshInterval());
  }

  /**
   * Configures the status bar item to reflect the "no API key" state.
   *
   * Sets the item's label to "Set API Key" and attaches the `zaiUsage.setApiKey`
   * command so that clicking the item opens the API key input prompt.
   *
   * @returns `void`
   */
  function applyNoApiKeyState(): void {
    statusBarItem.command = "zaiUsage.setApiKey";
    statusBarItem.text = getLabel("Set API Key");
    statusBarItem.tooltip = "Click to set your z.ai API key";
  }

  /**
   * Fetches the latest usage data and updates the status bar item accordingly.
   *
   * Possible outcomes:
   * - **No API key**: delegates to {@link applyNoApiKeyState} to prompt the user.
   * - **Fetch failure**: displays a dash and an error tooltip.
   * - **Success**: renders the usage percentage and optional reset countdown; also
   *   shows a tooltip with full details and the configured refresh interval.
   *
   * After a successful live API call ({@link fetchUsage} returns `apiCalled: true`),
   * the polling interval is restarted via {@link startInterval} so that the next
   * refresh is scheduled relative to the moment fresh data was obtained.
   *
   * @returns A promise that resolves once the status bar has been updated.
   */
  async function updateStatusBar(): Promise<void> {
    const { usage, apiCalled, noApiKey } = await fetchUsage();

    if (noApiKey) {
      applyNoApiKeyState();
    } else if (usage === null) {
      statusBarItem.command = undefined;
      statusBarItem.text = getLabel("-");
      statusBarItem.tooltip = "Unable to fetch z.ai usage data";
    } else {
      statusBarItem.command = undefined;
      const refreshSec = getRefreshInterval() / 1000;
      const resetStr = formatResetTime(usage.nextResetTime);
      const suffix = resetStr
        ? `${usage.percentage}% ${resetStr}`
        : `${usage.percentage}%`;
      statusBarItem.text = getLabel(suffix);
      statusBarItem.tooltip = `z.ai token usage: ${usage.percentage}%${resetStr ? ` — resets in ${resetStr.replace(/[()]/g, "")}` : ""} (auto-refreshes every ${refreshSec}s)`;
    }

    if (apiCalled) {
      startInterval();
    }
  }

  /**
   * Handles the `zaiUsage.setApiKey` command.
   *
   * Prompts the user for a Bearer token, verifies it against the z.ai API,
   * and — on success — persists it to the secret store and refreshes the status bar.
   * On verification failure the stored key and cache are both cleared.
   */
  const setApiKeyCmd = vscode.commands.registerCommand(
    "zaiUsage.setApiKey",
    async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: "Enter your z.ai API key",
        placeHolder: "Bearer token...",
        password: true,
        ignoreFocusOut: true,
      });

      if (!apiKey) {
        return;
      }

      statusBarItem.text = getLabel("Verifying...");
      const result = await fetchFromApi(apiKey);

      if (result === null) {
        await context.secrets.delete(API_KEY_SECRET);
        await context.globalState.update(CACHE_KEY, undefined);
        vscode.window.showErrorMessage(
          "z.ai Usage: Failed to verify API key. Please check the key and try again.",
        );
        await updateStatusBar();
        return;
      }

      await context.secrets.store(API_KEY_SECRET, apiKey);
      setCache(result);
      vscode.window.showInformationMessage(
        "z.ai Usage: API key saved successfully.",
      );
      await updateStatusBar();
      startInterval();
    },
  );

  /**
   * Handles the `zaiUsage.clearApiKey` command.
   *
   * Removes the stored API key from the secret store, clears the usage cache,
   * and transitions the status bar to the "no API key" state.
   */
  const clearApiKeyCmd = vscode.commands.registerCommand(
    "zaiUsage.clearApiKey",
    async () => {
      await context.secrets.delete(API_KEY_SECRET);
      await context.globalState.update(CACHE_KEY, undefined);
      applyNoApiKeyState();
      vscode.window.showInformationMessage("z.ai Usage: API key cleared.");
    },
  );

  updateStatusBar();
  startInterval();

  context.subscriptions.push(
    statusBarItem,
    setApiKeyCmd,
    clearApiKeyCmd,
    /**
     * Listens for workspace configuration changes and re-applies them immediately.
     *
     * When `zaiUsage.refreshInterval` or `zaiUsage.useIcon` changes, the status bar
     * is refreshed and the polling interval is restarted so the new settings take
     * effect without requiring a window reload.
     */
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("zaiUsage.refreshInterval") ||
        e.affectsConfiguration("zaiUsage.useIcon")
      ) {
        updateStatusBar();
        startInterval();
      }
    }),
    {
      dispose: () => {
        if (intervalId !== undefined) clearInterval(intervalId);
      },
    },
  );
}

/**
 * Deactivates the extension.
 * Called when VSCode is shutting down or the extension is disabled.
 */
export function deactivate(): void {}
