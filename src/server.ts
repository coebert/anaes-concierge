import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;
let devServerEntryReloadCount = 0;

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
  const cacheKey = `${Date.now()}-${devServerEntryReloadCount}`;
  const [serverCore, reactStartServer] = await Promise.all([
    import(`@tanstack/start-server-core?tanstack-router-retry=${cacheKey}`) as Promise<StartServerCoreModule>,
    import(`@tanstack/react-start-server?tanstack-router-retry=${cacheKey}`) as Promise<ReactStartServerModule>,
  ]);

  return {
    fetch: serverCore.createStartHandler(reactStartServer.defaultStreamHandler),
  };
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
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

function isStaleRouterEntryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // After HMR of src/routeTree.gen.ts, TanStack Start's cached entriesPromise
  // may hold a stale routerEntry whose getRouter export has been stripped.
  // The cached entriesPromise lives inside @tanstack/start-server-core, so the
  // retry must load a fresh dev-only copy of that module, not only our wrapper.
  return /routerEntry\.getRouter is not a function/.test(message);
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handler = await getServerEntry();
        const response = await handler.fetch(request, env, ctx);
        return await normalizeCatastrophicSsrResponse(response);
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
