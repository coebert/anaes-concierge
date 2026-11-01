import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  consumeRegistrationChallenge,
  verifyAuthenticationCore,
  type ChallengeRow,
  type CredentialRow,
} from "./passkey-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRpInfo() {
  const req = getRequest();
  const url = new URL(req.url);
  // Relying Party ID must be the effective domain (no port, no scheme).
  const rpID = url.hostname;
  const origin = url.origin;
  return { rpID, origin, rpName: "Salisbury Anaesthetics Rota" };
}

async function loadServer() {
  const [{ supabaseAdmin }, srv] = await Promise.all([
    import("@/integrations/supabase/client.server"),
    import("@simplewebauthn/server"),
  ]);
  return { supabaseAdmin, srv };
}

async function consumeById(
  supabaseAdmin: any,
  id: string,
  purpose: string,
): Promise<ChallengeRow | null> {
  const { data, error } = await supabaseAdmin.rpc("consume_passkey_challenge_by_id", {
    p_id: id,
    p_purpose: purpose,
  });
  if (error) throw new Error("Passkey service is temporarily unavailable.");
  return ((data as ChallengeRow[] | null) ?? [])[0] ?? null;
}

async function cleanupExpiredChallenges(supabaseAdmin: any) {
  await supabaseAdmin
    .from("passkey_challenges")
    .delete()
    .lt("expires_at", new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Registration (must be signed in)
// ---------------------------------------------------------------------------

export const startPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin, srv } = await loadServer();
    const { rpID, rpName } = getRpInfo();
    const userId = context.userId;

    const email = (context.claims as any)?.email as string | undefined;

    const { data: existing } = await supabaseAdmin
      .from("passkey_credentials")
      .select("credential_id, transports")
      .eq("user_id", userId);

    const options = await srv.generateRegistrationOptions({
      rpName,
      rpID,
      userID: new TextEncoder().encode(userId),
      userName: email ?? userId,
      userDisplayName: email ?? "User",
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
      excludeCredentials: (existing ?? []).map((c: any) => ({
        id: c.credential_id,
        transports: (c.transports ?? undefined) as any,
      })),
    });

    await cleanupExpiredChallenges(supabaseAdmin);
    const { data: chRow, error: chErr } = await supabaseAdmin
      .from("passkey_challenges")
      .insert({ user_id: userId, challenge: options.challenge, purpose: "registration" })
      .select("id")
      .single();
    if (chErr || !chRow) throw new Error("Could not start passkey registration. Try again.");

    return { options, ceremonyId: chRow.id as string };
  });

export const verifyPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { response: any; deviceName?: string; ceremonyId: string }) =>
    z
      .object({
        response: z.any(),
        deviceName: z.string().max(80).optional(),
        ceremonyId: z.string().guid(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, srv } = await loadServer();
    const { rpID, origin } = getRpInfo();
    const userId = context.userId;

    // Consume exactly this ceremony's challenge, once, and only for this user.
    const challenge = await consumeRegistrationChallenge(
      { consumeChallenge: (id, purpose) => consumeById(supabaseAdmin, id, purpose) },
      data.ceremonyId,
      userId,
    );

    const verification = await srv.verifyRegistrationResponse({
      response: data.response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("Passkey registration failed to verify.");
    }

    const { credential } = verification.registrationInfo;
    const publicKeyB64 = Buffer.from(credential.publicKey).toString("base64");

    const { error: insErr } = await supabaseAdmin.from("passkey_credentials").insert({
      user_id: userId,
      credential_id: credential.id,
      public_key: publicKeyB64,
      counter: credential.counter,
      transports: credential.transports ?? null,
      device_name: data.deviceName ?? null,
    });
    if (insErr) throw new Error(insErr.message);

    return { ok: true };
  });

// ---------------------------------------------------------------------------
// Authentication (public — no session yet)
// ---------------------------------------------------------------------------

export const startPasskeyAuthentication = createServerFn({ method: "POST" })
  .inputValidator((data: { email?: string } | undefined) =>
    z.object({ email: z.string().trim().email().max(255).optional() }).parse(data ?? {}),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin, srv } = await loadServer();
    const { rpID } = getRpInfo();
    const email = data.email?.toLowerCase();

    let userId: string | null = null;
    let allow: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];

    if (email) {
      const { data: idRow } = await supabaseAdmin.rpc("find_profile_id_by_email", {
        p_email: email,
      });
      userId = (idRow as unknown as string) ?? null;
      if (userId) {
        const { data: creds } = await supabaseAdmin
          .from("passkey_credentials")
          .select("credential_id, transports")
          .eq("user_id", userId);
        allow = (creds ?? []).map((c) => ({
          id: c.credential_id as string,
          transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
        }));
      }
    }

    const options = await srv.generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      // Empty allowCredentials => usernameless (discoverable-credential) flow.
      allowCredentials: email ? allow : [],
    });

    await cleanupExpiredChallenges(supabaseAdmin);
    // One row per ceremony; its random id is the only handle that can consume it.
    // user_id is bound when an email resolved to a user, NULL for usernameless.
    const { data: chRow, error: chErr } = await supabaseAdmin
      .from("passkey_challenges")
      .insert({ user_id: userId, challenge: options.challenge, purpose: "authentication" })
      .select("id")
      .single();
    if (chErr || !chRow) throw new Error("Could not start passkey sign-in. Try again.");

    // Do NOT return `hasPasskeys` — that leaks account enumeration. The
    // client always attempts the ceremony; failure surfaces uniformly.
    return { options, ceremonyId: chRow.id as string };
  });

export const verifyPasskeyAuthentication = createServerFn({ method: "POST" })
  .inputValidator((data: { email?: string; response: unknown; ceremonyId: string }) =>
    z
      .object({
        email: z.string().trim().email().max(255).optional(),
        response: z.any(),
        ceremonyId: z.string().guid(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin, srv } = await loadServer();
    const { rpID, origin } = getRpInfo();

    const { userId } = await verifyAuthenticationCore(
      {
        insertChallenge: async () => {
          throw new Error("unused");
        },
        consumeChallenge: (id, purpose) => consumeById(supabaseAdmin, id, purpose),
        findCredential: async (credentialId) => {
          const { data: rows, error } = await supabaseAdmin
            .from("passkey_credentials")
            .select("id, user_id, credential_id, public_key, counter, transports")
            .eq("credential_id", credentialId)
            .limit(1);
          if (error) throw new Error("Passkey sign-in is temporarily unavailable.");
          return (rows?.[0] as CredentialRow | undefined) ?? null;
        },
        findProfileIdByEmail: async (email) => {
          const { data: id, error } = await supabaseAdmin.rpc("find_profile_id_by_email", {
            p_email: email,
          });
          if (error) throw new Error("Passkey sign-in is temporarily unavailable.");
          return (id as unknown as string) ?? null;
        },
        updateCounter: async (id, counter) => {
          const { error } = await supabaseAdmin
            .from("passkey_credentials")
            .update({ counter, last_used_at: new Date().toISOString() })
            .eq("id", id);
          if (error) throw new Error("Passkey sign-in is temporarily unavailable.");
        },
        verify: async ({
          response,
          expectedChallenge,
          expectedOrigin,
          expectedRPID,
          credential,
        }) => {
          const v = await srv.verifyAuthenticationResponse({
            response: response as never,
            expectedChallenge,
            expectedOrigin,
            expectedRPID,
            credential: {
              id: credential.credential_id,
              publicKey: new Uint8Array(Buffer.from(credential.public_key, "base64")),
              counter: Number(credential.counter),
              transports: (credential.transports ?? undefined) as
                | AuthenticatorTransportFuture[]
                | undefined,
            },
            requireUserVerification: true,
          });
          return { verified: v.verified, newCounter: v.authenticationInfo.newCounter };
        },
      },
      { ceremonyId: data.ceremonyId, email: data.email, response: data.response, origin, rpID },
    );

    // Look up the user's email so we can mint a magic-link session token.
    const { data: userRec, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId);
    const email = userRec?.user?.email;
    if (userErr || !email) {
      throw new Error(userErr?.message ?? "Could not resolve account email.");
    }

    // Mint a one-shot magic link token the client exchanges for a session.
    const { data: link, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr || !link?.properties?.hashed_token) {
      throw new Error(linkErr?.message ?? "Failed to mint session token.");
    }

    return { tokenHash: link.properties.hashed_token };
  });

// ---------------------------------------------------------------------------
// Manage stored passkeys
// ---------------------------------------------------------------------------

export const listMyPasskeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("passkey_credentials")
      .select("id, device_name, created_at, last_used_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const deleteMyPasskey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => z.object({ id: z.string().guid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("passkey_credentials")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
