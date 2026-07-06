import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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
    await supabaseAdmin.from("passkey_challenges").insert({
      user_id: userId,
      challenge: options.challenge,
      purpose: "registration",
    });

    return options;
  });

export const verifyPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { response: any; deviceName?: string }) =>
    z.object({ response: z.any(), deviceName: z.string().max(80).optional() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, srv } = await loadServer();
    const { rpID, origin } = getRpInfo();
    const userId = context.userId;

    // Atomically consume the latest non-expired registration challenge so a
    // replay/concurrent request cannot reuse it.
    const { data: consumed, error: consumeErr } = await supabaseAdmin.rpc(
      "consume_passkey_challenge" as never,
      { p_user_id: userId, p_purpose: "registration" } as never,
    );
    if (consumeErr) throw new Error(consumeErr.message);
    const challenge = (consumed as unknown as { challenge: string }[] | null)?.[0]?.challenge;
    if (!challenge) {
      throw new Error("Passkey challenge expired. Try again.");
    }

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
    z
      .object({ email: z.string().trim().email().max(255).optional() })
      .parse(data ?? {}),
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
          transports: (c.transports ?? undefined) as
            | AuthenticatorTransportFuture[]
            | undefined,
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
    // Store challenge keyed by user when known; otherwise as a global
    // (user_id NULL) challenge for the discoverable flow.
    await supabaseAdmin.from("passkey_challenges").insert({
      user_id: userId,
      challenge: options.challenge,
      purpose: "authentication",
    });

    // Do NOT return `hasPasskeys` — that leaks account enumeration. The
    // client always attempts the ceremony; failure surfaces uniformly.
    return { options };
  });

export const verifyPasskeyAuthentication = createServerFn({ method: "POST" })
  .inputValidator((data: { email?: string; response: unknown }) =>
    z
      .object({
        email: z.string().trim().email().max(255).optional(),
        response: z.any(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin, srv } = await loadServer();
    const { rpID, origin } = getRpInfo();

    const credId = (data.response as { id?: string })?.id;
    if (!credId) throw new Error("Malformed passkey response.");

    // Resolve the credential first so discoverable (usernameless) flows work.
    const { data: creds } = await supabaseAdmin
      .from("passkey_credentials")
      .select("*")
      .eq("credential_id", credId)
      .limit(1);
    const cred = creds?.[0];
    if (!cred) throw new Error("Unknown passkey.");
    const userId = cred.user_id as string;

    // If an email was provided, ensure it matches the credential owner.
    if (data.email) {
      const { data: expectedId } = await supabaseAdmin.rpc(
        "find_profile_id_by_email",
        { p_email: data.email.toLowerCase() },
      );
      if (!expectedId || expectedId !== userId) {
        throw new Error("Passkey does not match this account.");
      }
    }

    // Atomically consume the challenge so a concurrent request cannot reuse it.
    const { data: consumed, error: consumeErr } = await supabaseAdmin.rpc(
      "consume_passkey_challenge" as never,
      { p_user_id: userId, p_purpose: "authentication" } as never,
    );
    if (consumeErr) throw new Error(consumeErr.message);
    const challenge = (consumed as unknown as { challenge: string }[] | null)?.[0]
      ?.challenge;
    if (!challenge) {
      throw new Error("Passkey challenge expired. Try again.");
    }

    const verification = await srv.verifyAuthenticationResponse({
      response: data.response as never,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(Buffer.from(cred.public_key, "base64")),
        counter: Number(cred.counter),
        transports: (cred.transports ?? undefined) as
          | AuthenticatorTransportFuture[]
          | undefined,
      },
      requireUserVerification: true,
    });

    if (!verification.verified) throw new Error("Passkey verification failed.");

    await supabaseAdmin
      .from("passkey_credentials")
      .update({
        counter: verification.authenticationInfo.newCounter,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", cred.id);

    // Look up the user's email so we can mint a magic-link session token.
    const { data: userRec, error: userErr } =
      await supabaseAdmin.auth.admin.getUserById(userId);
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
  .inputValidator((data: { id: string }) =>
    z.object({ id: z.string().uuid() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("passkey_credentials")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
