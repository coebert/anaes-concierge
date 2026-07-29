import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;
let devServerEntryReloadCount = 0;
const DEV_SERVER_ENTRY_RETRY_SLOTS = 12;

type StartServerCoreModule = {
  createStartHandler: (handler: unknown) => ServerEntry["fetch"];
};

type ReactStartServerModule = {
  defaultStreamHandler: unknown;
};

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => ((m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry)),
    );
  }
  return serverEntryPromise;
}

async function createFreshDevServerEntry(): Promise<ServerEntry> {
  devServerEntryReloadCount += 1;
  const [serverCore, reactStartServer] = await loadFreshDevServerModules(
    devServerEntryReloadCount % DEV_SERVER_ENTRY_RETRY_SLOTS,
  );

  return {
    fetch: serverCore.createStartHandler(reactStartServer.defaultStreamHandler),
  };
}

function loadFreshDevServerModules(
  slot: number,
): Promise<[StartServerCoreModule, ReactStartServerModule]> {
  // Vite cannot transform a variable package import like
  // import(`@tanstack/start-server-core?retry=${Date.now()}`), so keep the
  // cache-busting imports as static literals and rotate through them. Each
  // slot gets its own copy of start-server-core, including its internal
  // entriesPromise, which lets a stale router-entry cache recover without a
  // full dev-server restart.
  switch (slot) {
    case 0:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=0") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=0") as Promise<ReactStartServerModule>,
      ]);
    case 1:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=1") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=1") as Promise<ReactStartServerModule>,
      ]);
    case 2:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=2") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=2") as Promise<ReactStartServerModule>,
      ]);
    case 3:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=3") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=3") as Promise<ReactStartServerModule>,
      ]);
    case 4:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=4") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=4") as Promise<ReactStartServerModule>,
      ]);
    case 5:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=5") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=5") as Promise<ReactStartServerModule>,
      ]);
    case 6:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=6") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=6") as Promise<ReactStartServerModule>,
      ]);
    case 7:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=7") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=7") as Promise<ReactStartServerModule>,
      ]);
    case 8:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=8") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=8") as Promise<ReactStartServerModule>,
      ]);
    case 9:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=9") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=9") as Promise<ReactStartServerModule>,
      ]);
    case 10:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=10") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=10") as Promise<ReactStartServerModule>,
      ]);
    default:
      return Promise.all([
        import("@tanstack/start-server-core?tanstack-router-retry=11") as Promise<StartServerCoreModule>,
        import("@tanstack/react-start-server?tanstack-router-retry=11") as Promise<ReactStartServerModule>,
      ]);
  }
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  return normalizeCatastrophicSsrResponseWithObservedError(response);
}

async function normalizeCatastrophicSsrResponseWithObservedError(
  response: Response,
  observedError?: unknown,
): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  const capturedError = observedError ?? consumeLastCapturedError();
  if (isStaleRouterEntryError(capturedError)) {
    throw capturedError instanceof Error
      ? capturedError
      : new Error(String(capturedError));
  }

  console.error(capturedError ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

function stringifyErrorForMatching(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
    return [error.name, error.message, error.stack, stringifyErrorForMatching(cause)]
      .filter(Boolean)
      .join("\n");
  }

  if (error && typeof error === "object") {
    const maybeError = error as { message?: unknown; stack?: unknown; cause?: unknown };
    return [
      typeof maybeError.message === "string" ? maybeError.message : undefined,
      typeof maybeError.stack === "string" ? maybeError.stack : undefined,
      stringifyErrorForMatching(maybeError.cause),
    ]
      .filter(Boolean)
      .join("\n");
  }

  return error == null ? "" : String(error);
}

function isStaleRouterEntryError(error: unknown): boolean {
  // After HMR of src/routeTree.gen.ts, TanStack Start's cached entriesPromise
  // may hold a stale routerEntry whose getRouter export has been stripped.
  // The cached entriesPromise lives inside @tanstack/start-server-core, so the
  // retry must load a fresh dev-only copy of that module, not only our wrapper.
  return /routerEntry\.getRouter is not a function/.test(stringifyErrorForMatching(error));
}

async function captureConsoleErrorDuring<T>(
  callback: () => Promise<T> | T,
): Promise<{ result: T; staleRouterEntryError?: unknown }> {
  let staleRouterEntryError: unknown;
  const originalConsoleError = console.error;
  const wrappedConsoleError: typeof console.error = (...args: Parameters<typeof console.error>) => {
    staleRouterEntryError ??= args.find(isStaleRouterEntryError);
    originalConsoleError(...args);
  };

  console.error = wrappedConsoleError;
  try {
    const result = await callback();
    return { result, staleRouterEntryError };
  } finally {
    if (console.error === wrappedConsoleError) {
      console.error = originalConsoleError;
    }
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handler = await getServerEntry();
        const { result: response, staleRouterEntryError } = await captureConsoleErrorDuring(() =>
          handler.fetch(request, env, ctx),
        );
        return await normalizeCatastrophicSsrResponseWithObservedError(
          response,
          staleRouterEntryError,
        );
      } catch (error) {
        if (attempt === 0 && isStaleRouterEntryError(error)) {
          serverEntryPromise = createFreshDevServerEntry();
          continue;
        }
        console.error(error);
        return brandedErrorResponse();
      }
    }
    return brandedErrorResponse();
  },
};
