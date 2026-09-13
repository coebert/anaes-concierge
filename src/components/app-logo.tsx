import { cn } from "@/lib/utils";

type AppLogoProps = {
  className?: string;
};

export function AppLogo({ className }: AppLogoProps) {
  return (
    <img
      src="/app-icon-192.png"
      alt=""
      aria-hidden="true"
      width={192}
      height={192}
      className={cn("block shrink-0", className)}
    />
  );
}
