import * as vscode from "vscode";

interface ZaiLimit {
  type: string;
  percentage: number;
  nextResetTime: number;
}

interface ZaiApiResponse {
  success?: boolean;
  code?: number;
  msg?: string;
  data: {
    limits: ZaiLimit[];
  };
}

interface CacheData {
  version: string;
  timestamp: number;
  data: ZaiApiResponse;
}

interface UsageData {
  percentage: number;
  nextResetTime: number | null;
}

const CACHE_VERSION = "1.0";
const CACHE_KEY = "zaiUsage.cache";
const API_KEY_SECRET = "zaiUsage.apiKey";

/**
 * Activates the extension.
 * @param context - The extension context provided by VSCode.
 */
export function activate(context: vscode.ExtensionContext) {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = getLabel("...");
  statusBarItem.show();

  function getCache(): CacheData | null {
    const cache = context.globalState.get<CacheData>(CACHE_KEY);
    if (!cache || cache.version !== CACHE_VERSION) {
      return null;
    }
    return cache;
  }

  function setCache(data: ZaiApiResponse): void {
    context.globalState.update(CACHE_KEY, {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      data,
    } satisfies CacheData);
  }

  function isCacheValid(cache: CacheData | null): boolean {
    if (!cache) {
      return false;
    }
    if (Date.now() - cache.timestamp >= getRefreshInterval()) {
      return false;
    }
    // キャッシュ内の nextResetTime が過去なら無効化して最新データを取得する
    const usage = extractUsageData(cache.data);
    if (usage?.nextResetTime && usage.nextResetTime <= Date.now()) {
      return false;
    }
    return true;
  }

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

  async function fetchFromApi(apiKey: string): Promise<ZaiApiResponse | null> {
    try {
      const response = await fetch(
        "https://api.z.ai/api/monitor/usage/quota/limit",
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
      );

      if (!response.ok) {
        console.error(
          "[z.ai Usage] API HTTP error:",
          response.status,
          await response.text(),
        );
        return null;
      }

      const data: ZaiApiResponse = await response.json();

      // HTTP 200 でも認証エラーが返ることがあるためペイロードを確認する
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

    // API 失敗時は期限切れキャッシュにフォールバック
    if (cache) {
      return {
        usage: extractUsageData(cache.data),
        apiCalled: false,
        noApiKey: false,
      };
    }

    return { usage: null, apiCalled: false, noApiKey: false };
  }

  function getRefreshInterval(): number {
    const seconds = vscode.workspace
      .getConfiguration("zaiUsage")
      .get<number>("refreshInterval", 60);
    // Clamp to a minimum of 10 seconds to prevent API flooding from invalid config values.
    return Math.max(seconds, 10) * 1000;
  }

  function getLabel(suffix: string): string {
    const useIcon = vscode.workspace
      .getConfiguration("zaiUsage")
      .get<boolean>("useIcon", true);
    const prefix = useIcon ? "$(zai-icon)" : "z.ai:";
    return `${prefix} ${suffix}`;
  }

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

  let intervalId: ReturnType<typeof setInterval> | undefined;

  function startInterval() {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }
    intervalId = setInterval(updateStatusBar, getRefreshInterval());
  }

  async function updateStatusBar() {
    const { usage, apiCalled, noApiKey } = await fetchUsage();

    if (noApiKey) {
      statusBarItem.command = "zaiUsage.setApiKey";
      statusBarItem.text = getLabel("Set API Key");
      statusBarItem.tooltip = "Click to set your z.ai API key";
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

  const clearApiKeyCmd = vscode.commands.registerCommand(
    "zaiUsage.clearApiKey",
    async () => {
      await context.secrets.delete(API_KEY_SECRET);
      await context.globalState.update(CACHE_KEY, undefined);
      statusBarItem.command = "zaiUsage.setApiKey";
      statusBarItem.text = getLabel("Set API Key");
      statusBarItem.tooltip = "Click to set your z.ai API key";
      vscode.window.showInformationMessage("z.ai Usage: API key cleared.");
    },
  );

  updateStatusBar();
  startInterval();

  context.subscriptions.push(
    statusBarItem,
    setApiKeyCmd,
    clearApiKeyCmd,
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
export function deactivate() {}
