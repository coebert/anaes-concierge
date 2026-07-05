import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { useServerFn } from "@tanstack/react-start";
import {
  startPasskeyRegistration,
  verifyPasskeyRegistration,
  listMyPasskeys,
  deleteMyPasskey,
} from "@/lib/passkeys.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Fingerprint, Trash2 } from "lucide-react";

type Passkey = {
  id: string;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
};

export function PasskeyManager() {
  const startReg = useServerFn(startPasskeyRegistration);
  const verifyReg = useServerFn(verifyPasskeyRegistration);
  const listFn = useServerFn(listMyPasskeys);
  const deleteFn = useServerFn(deleteMyPasskey);

  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const rows = await listFn();
      setPasskeys(rows as Passkey[]);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enroll = async () => {
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      toast.error("This device does not support passkeys.");
      return;
    }
    setBusy(true);
    try {
      const options = await startReg();
      const attResp = await startRegistration({ optionsJSON: options as any });
      const deviceName =
        /iPhone|iPad|iPod/i.test(navigator.userAgent)
          ? "iOS device"
          : /Android/i.test(navigator.userAgent)
            ? "Android device"
            : /Mac/i.test(navigator.userAgent)
              ? "Mac"
              : /Windows/i.test(navigator.userAgent)
                ? "Windows device"
                : "This device";
      await verifyReg({ data: { response: attResp, deviceName } });
      toast.success("Passkey registered");
      await refresh();
    } catch (e: any) {
      if (e?.name === "NotAllowedError") {
        toast.error("Cancelled");
      } else {
        toast.error(e?.message ?? "Failed to register passkey");
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Remove this passkey?")) return;
    try {
      await deleteFn({ data: { id } });
      toast.success("Passkey removed");
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to remove");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="h-5 w-5" /> Biometric sign-in (passkeys)
        </CardTitle>
        <CardDescription>
          Use Face ID, Touch ID, Windows Hello, or a hardware key to sign in without a password on this device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={enroll} disabled={busy}>
          {busy ? "Registering…" : "Register this device"}
        </Button>
        <div className="space-y-2">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : passkeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No passkeys registered yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {passkeys.map((p) => (
                <li key={p.id} className="flex items-center justify-between p-3">
                  <div>
                    <p className="text-sm font-medium">{p.device_name ?? "Unnamed device"}</p>
                    <p className="text-xs text-muted-foreground">
                      Added {new Date(p.created_at).toLocaleDateString()}
                      {p.last_used_at
                        ? ` · Last used ${new Date(p.last_used_at).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => remove(p.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
