import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import {
  getCurrentSubscription,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push-notifications";

export function PushNotificationsCard() {
  const { user } = useAuth();
  const [supported, setSupported] = useState<boolean>(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [subscribed, setSubscribed] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ok = isPushSupported();
    setSupported(ok);
    if (!ok) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission);
    getCurrentSubscription()
      .then((s) => setSubscribed(!!s))
      .catch(() => setSubscribed(false));
  }, []);

  const handleEnable = async () => {
    if (!user?.id) return;
    setBusy(true);
    try {
      await subscribeToPush(user.id);
      setSubscribed(true);
      setPermission(Notification.permission);
      toast.success("Push notifications enabled on this device");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not enable push notifications");
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    try {
      await unsubscribeFromPush();
      setSubscribed(false);
      toast.success("Push notifications disabled on this device");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disable push notifications");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Push notifications</CardTitle>
        <CardDescription>
          Get a browser notification when one of your scheduled lists changes within 48 hours of the session
          (added, removed, swapped, or details edited).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!supported && (
          <p className="text-sm text-muted-foreground">
            This browser does not support web push notifications. On iPhone, add this site to your Home Screen
            first, then open it from there.
          </p>
        )}
        {supported && permission === "denied" && (
          <p className="text-sm text-muted-foreground">
            Notifications are blocked for this site in your browser settings. Allow notifications and try again.
          </p>
        )}
        {supported && permission !== "denied" && (
          <div className="flex items-center gap-3">
            <p className="text-sm">
              Status:{" "}
              <span className="font-medium">
                {subscribed ? "Enabled on this device" : "Not enabled on this device"}
              </span>
            </p>
            {subscribed ? (
              <Button variant="outline" size="sm" onClick={handleDisable} disabled={busy}>
                {busy ? "Working…" : "Disable"}
              </Button>
            ) : (
              <Button size="sm" onClick={handleEnable} disabled={busy}>
                {busy ? "Working…" : "Enable notifications"}
              </Button>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          You need to enable this once per device / browser you want notifications on.
        </p>
      </CardContent>
    </Card>
  );
}
