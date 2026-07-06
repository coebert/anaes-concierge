import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { useServerFn } from "@tanstack/react-start";
import {
  startPasskeyRegistration,
  verifyPasskeyRegistration,
  listMyPasskeys,
  deleteMyPasskey,
} from "@/lib/passkeys.functions";
import { detectDeviceName } from "@/lib/passkey-device-name";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Fingerprint, Trash2 } from "lucide-react";

type Passkey = {
  id: string;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
};

const PASSKEYS_QUERY_KEY = ["my-passkeys"] as const;

export function PasskeyManager() {
  const qc = useQueryClient();
  const startReg = useServerFn(startPasskeyRegistration);
  const verifyReg = useServerFn(verifyPasskeyRegistration);
  const listFn = useServerFn(listMyPasskeys);
  const deleteFn = useServerFn(deleteMyPasskey);

  const [pendingDelete, setPendingDelete] = useState<Passkey | null>(null);

  const { data: passkeys, isLoading } = useQuery({
    queryKey: PASSKEYS_QUERY_KEY,
    queryFn: async () => (await listFn()) as Passkey[],
  });

  const enroll = useMutation({
    mutationFn: async () => {
      if (typeof window === "undefined" || !window.PublicKeyCredential) {
        throw new Error("This device does not support passkeys.");
      }
      const options = (await startReg()) as PublicKeyCredentialCreationOptionsJSON;
      const attResp = await startRegistration({ optionsJSON: options });
      await verifyReg({
        data: { response: attResp, deviceName: detectDeviceName() },
      });
    },
    onSuccess: () => {
      toast.success("Passkey registered");
      qc.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY });
    },
    onError: (e: unknown) => {
      if (e instanceof Error && e.name === "NotAllowedError") {
        toast.error("Cancelled");
      } else {
        toast.error(e instanceof Error ? e.message : "Failed to register passkey");
      }
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await deleteFn({ data: { id } });
    },
    onSuccess: () => {
      toast.success("Passkey removed");
      qc.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Failed to remove");
    },
    onSettled: () => setPendingDelete(null),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="h-5 w-5" /> Biometric sign-in (passkeys)
        </CardTitle>
        <CardDescription>
          Use Face ID, Touch ID, Windows Hello, or a hardware key to sign in
          without a password on this device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={() => enroll.mutate()} disabled={enroll.isPending}>
          {enroll.isPending ? "Registering…" : "Register this device"}
        </Button>
        <div className="space-y-2">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !passkeys || passkeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No passkeys registered yet.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {passkeys.map((p) => (
                <li key={p.id} className="flex items-center justify-between p-3">
                  <div>
                    <p className="text-sm font-medium">
                      {p.device_name ?? "Unnamed device"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Added {new Date(p.created_at).toLocaleDateString()}
                      {p.last_used_at
                        ? ` · Last used ${new Date(p.last_used_at).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingDelete(p)}
                    aria-label={`Remove ${p.device_name ?? "passkey"}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              You&apos;ll no longer be able to sign in with{" "}
              <span className="font-medium">
                {pendingDelete?.device_name ?? "this device"}
              </span>
              . You can register it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (pendingDelete) remove.mutate(pendingDelete.id);
              }}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
