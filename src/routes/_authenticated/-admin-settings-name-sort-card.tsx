import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useNameSortDirection, setNameSortDirection } from "@/lib/name-sort";

export function NameSortPreferenceCard() {
  const qc = useQueryClient();
  const direction = useNameSortDirection();
  const isDescending = direction === "desc";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Display preferences</CardTitle>
        <CardDescription>
          Personal display options — stored on this device only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="staff-name-sort-toggle" className="text-sm font-medium">
              Sort staff name lists Z→A by surname
            </Label>
            <p className="text-xs text-muted-foreground">
              {isDescending
                ? "Lists currently show Zhang before Adams."
                : "Lists currently show Adams before Zhang. Toggle on to reverse."}
            </p>
          </div>
          <Switch
            id="staff-name-sort-toggle"
            checked={isDescending}
            onCheckedChange={(checked) => {
              setNameSortDirection(checked ? "desc" : "asc");
              // Refresh every query so queryFn sorts re-run with the new direction.
              void qc.invalidateQueries();
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
