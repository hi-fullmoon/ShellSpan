import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, autoComplete = "off", ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      autoComplete={autoComplete}
      data-slot="textarea"
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
