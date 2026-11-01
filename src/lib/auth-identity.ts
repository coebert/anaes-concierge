import type { QueryClient } from "@tanstack/react-query";

/**
 * Tracks which account the client-side caches belong to. When the signed-in
 * identity changes (sign-out, or a different user signs in on the same tab)
 * the load generation is bumped and the whole cache is dropped
 * SYNCHRONOUSLY, so nothing from the previous account can render or settle
 * under the new identity. In-flight queries are cancelled fire-and-forget:
 * the purge never waits on (possibly unbounded) cancellation.
 *
 * Also hands out load tokens so a slow profile/roles fetch for a previous
 * identity can never install its result after the identity has moved on.
 * A same-user event (token refresh) changes nothing.
 */
export class AuthIdentityGuard {
  private currentUserId: string | null | undefined = undefined;
  private generation = 0;

  constructor(private readonly queryClient: Pick<QueryClient, "cancelQueries" | "clear">) {}

  get userId(): string | null | undefined {
    return this.currentUserId;
  }

  /** True when `userId` differs from the identity currently installed. */
  isChange(userId: string | null): boolean {
    return this.currentUserId !== userId;
  }

  /**
   * Synchronously install `userId`. Returns true when caches were purged
   * (a real switch away from a previously observed identity).
   */
  setIdentity(userId: string | null): boolean {
    const prev = this.currentUserId;
    if (prev === userId) return false; // token refresh / duplicate event
    this.currentUserId = userId;
    this.generation += 1;
    if (prev === undefined) return false; // first observation: nothing stale
    try {
      // Fire-and-forget: a hanging cancellation must never delay the purge.
      void Promise.resolve(this.queryClient.cancelQueries()).catch(() => undefined);
    } catch {
      /* ignore */
    }
    this.queryClient.clear();
    return true;
  }

  beginLoad(userId: string | null): { userId: string | null; generation: number } {
    return { userId, generation: this.generation };
  }

  isCurrent(token: { userId: string | null; generation: number }): boolean {
    return token.generation === this.generation && token.userId === this.currentUserId;
  }
}
