import { cn } from "@/lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 shrink-0 animate-spinner motion-reduce:animate-none", className)}
      {...props}
    >
      <circle cx="12" cy="12" r="9" pathLength="100" strokeDasharray="80 20" />
    </svg>
  )
}

export { Spinner }
