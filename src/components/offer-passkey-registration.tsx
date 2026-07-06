import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { useServerFn } from "@tanstack/react-start";
import {
  startPasskeyRegistration,
  verifyPasskeyRegistration,
  listMyPasskeys,
} from "@/features/passkeys/passkeys.functions";
import { detectDeviceName } from "@/lib/passkey-device-name";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Fingerprint } from "lucide-react";

type Props = {
  onDone: () => void;
};

/** Post-sign-in prompt encouraging the user to register their first passkey. */
export function OfferPasskeyRegistration({ onDone }: Props) {
  const startReg = useServerFn(startPasskeyRegistration);
  const verifyReg = useServerFn(verifyPasskeyRegistration);
  const [busy, setBusy] = useState(false);

  const enroll = async () => {
    setBusy(true);
    try {
      const options = (await startReg()) as PublicKeyCredentialCreationOptionsJSON;
      const attResp = await startRegistration({ optionsJSON: options });
      await verifyReg({
        data: { response: attResp, deviceName: detectDeviceName() },
      });
      toast.success("Passkey registered — you can use it next time");
      onDone();
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "NotAllowedError") {
        toast.error("Cancelled");
      } else {
        toast.error(e instanceof Error ? e.message : "Failed to register passkey");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Fingerprint className="h-6 w-6" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">Set up a passkey for faster sign-in?</p>
        <p className="text-sm text-muted-foreground">
          Use Face ID, Touch ID, or Windows Hello to sign in without a password
          next time on this device.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Button onClick={enroll} disabled={busy}>
          {busy ? "Registering…" : "Register a passkey"}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          Not now
        </Button>
      </div>
    </div>
  );
}

/**
 * Detect whether the current device could plausibly store a passkey and the
 * signed-in user has none yet. Returns false on any error or unsupported UA.
 */
export async function shouldOfferPasskey(
  listFn: () => Promise<unknown>,
): Promise<boolean> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
  try {
    const pkc = window.PublicKeyCredential as unknown as {
      isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
    };
    const available =
      (await pkc.isUserVerifyingPlatformAuthenticatorAvailable?.()) ?? false;
    if (!available) return false;
    const existing = (await listFn()) as unknown[];
    return Array.isArray(existing) && existing.length === 0;
  } catch {
    return false;
  }
}
