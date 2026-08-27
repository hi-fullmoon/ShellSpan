interface RunbookEvidenceOutputProps {
  children: string;
}

export function RunbookEvidenceOutput({
  children,
}: RunbookEvidenceOutputProps): React.JSX.Element {
  return (
    <code
      data-slot="runbook-evidence-output"
      className="block max-h-40 overflow-auto whitespace-pre-wrap break-words"
    >
      {children}
    </code>
  );
}
