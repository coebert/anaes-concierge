import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  startAuthentication,
  browserSupportsWebAuthnAutofill,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  startPasskeyAuthentication,
  verifyPasskeyAuthentication,
} from "@/lib/passkeys.functions";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Fingerprint } from "lucide-react";

type Props = {
  /** Current email input value — passed only when the user clicks the button. */
  email: string;
  /** Fires after the Supabase session is established. */
  onSuccess: () => void;
  disabled?: boolean;
  /**
   * When true, silently arm the browser's conditional-mediation autofill so
   * that focusing the email field surfaces available passkeys.
   */
  enableConditionalMediation?: boolean;
};

/**
 * Explicit "Sign in with passkey" button plus (optional) conditional-mediation
 * autofill that runs in the background. The autofill ceremony resolves when
 * the user selects a discoverable credential from the browser prompt.
 */
export function PasskeyLoginButton({
  email,
  onSuccess,
  disabled,
  enableConditionalMediation = true,
}: Props) {
  const startPk = useServerFn(startPasskeyAuthentication);
  const verifyPk = useServerFn(verifyPasskeyAuthentication);
  const [busy, setBusy] = useState(false);
  const autofillArmed = useRef(false);

  const completeCeremony = async (
    assertion: AuthenticationResponseJSON,
    emailForServer?: string,
  ) => {
    const { tokenHash } = await verifyPk({
      data: { email: emailForServer, response: assertion },
    });
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: "magiclink",
    });
    if (error) throw error;
    onSuccess();
  };

  // Conditional mediation: fire-and-forget usernameless ceremony that
  // resolves when the user picks a passkey from the autofill dropdown.
  useEffect(() => {
    if (!enableConditionalMediation) return;
    if (autofillArmed.current) return;
    if (typeof window === "undefined" || !window.PublicKeyCredential) return;
    autofillArmed.current = true;

    (async () => {
      try {
        if (!(await browserSupportsWebAuthnAutofill())) return;
        const { options } = (await startPk({ data: {} })) as {
          options: PublicKeyCredentialRequestOptionsJSON;
        };
        const assertion = await startAuthentication({
          optionsJSON: options,
          useBrowserAutofill: true,
        });
        await completeCeremony(assertion);
      } catch {
        // Autofill was cancelled, unsupported, or the input wasn't tagged —
        // silently ignore; the explicit button remains available.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableConditionalMediation]);

  const handleClick = async () => {
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      toast.error("This device does not support passkeys.");
      return;
    }
    // Email is optional — usernameless flow works if the user has a
    // discoverable credential. If they typed one, we hand it to the server.
    const parsedEmail = z
      .string()
      .trim()
      .email()
      .safeParse(email);
    const emailForServer = parsedEmail.success ? parsedEmail.data : undefined;

    setBusy(true);
    try {
      const { options } = (await startPk({
        data: emailForServer ? { email: emailForServer } : {},
      })) as { options: PublicKeyCredentialRequestOptionsJSON };
      const assertion = await startAuthentication({ optionsJSON: options });
      await completeCeremony(assertion, emailForServer);
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "NotAllowedError") {
        toast.error("Cancelled");
      } else {
        toast.error(e instanceof Error ? e.message : "Passkey sign-in failed");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={handleClick}
      disabled={disabled || busy}
    >
      <Fingerprint className="mr-2 h-4 w-4" />
      {busy ? "Verifying passkey…" : "Sign in with passkey"}
    </Button>
  );
}
