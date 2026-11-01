import type { QueryClient } from "@tanstack/react-query";

/**
 * Tracks which account the client-side caches belong to. When the signed-in
 * identity changes (sign-out, or a different user signs in on the same tab)
 * every in-flight query is cancelled and the whole cache is dropped so no
 * previous-account data can render under the new identity.
 *
 * Also hands out load tokens so a slow profile/roles fetch for a previous
 * identity can never install its result after the identity has moved on.
 */
export class AuthIdentityGuard {
  private currentUserId: string | null | undefined = undefined;
  private generation = 0;

  constructor(private readonly queryClient: Pick<QueryClient, "cancelQueries" | "clear">) {}

  /** Returns true when the identity actually changed and caches were purged. */
  async setIdentity(userId: string | null): Promise<boolean> {
    const prev = this.currentUserId;
    this.currentUserId = userId;
    this.generation += 1;
    // First observation (initial mount) of an identity: nothing stale to purge.
    if (prev === undefined || prev === userId) return false;
    await this.queryClient.cancelQueries();
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
