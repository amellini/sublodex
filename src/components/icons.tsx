/** Inline SVG icons — flat, single-color (currentColor), Monokai-friendly. */

type IconProps = { size?: number; className?: string };

export function MessagesIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M2 4.25A1.75 1.75 0 0 1 3.75 2.5h8.5A1.75 1.75 0 0 1 14 4.25v5.5A1.75 1.75 0 0 1 12.25 11.5H6.5L3.5 14v-2.5A1.75 1.75 0 0 1 2 9.75v-5.5Z" />
      <path d="M4.75 5.5h6.5" />
      <path d="M4.75 8h4.5" />
    </svg>
  );
}

export function GitBranchIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="4" cy="13" r="1.5" />
      <circle cx="12" cy="6" r="1.5" />
      <path d="M4 4.5v7" />
      <path d="M12 7.5c0 2.5-2 4-4 4H6" />
    </svg>
  );
}

export function PencilIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="m11 2 3 3-7.5 7.5L3 13l.5-3.5L11 2Z" />
      <path d="m9.5 3.5 3 3" />
    </svg>
  );
}

export function TrashIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M2.5 4h11" />
      <path d="M6 4V2.5A1 1 0 0 1 7 1.5h2A1 1 0 0 1 10 2.5V4" />
      <path d="M3.75 4 4.5 13a1.5 1.5 0 0 0 1.5 1.4h4a1.5 1.5 0 0 0 1.5-1.4L12.25 4" />
      <path d="M6.75 7v4.5M9.25 7v4.5" />
    </svg>
  );
}

export function FolderIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M1.5 4.25A1.75 1.75 0 0 1 3.25 2.5h2.69c.46 0 .9.18 1.23.51L8.18 4H12.75A1.75 1.75 0 0 1 14.5 5.75V11.75A1.75 1.75 0 0 1 12.75 13.5h-9.5A1.75 1.75 0 0 1 1.5 11.75V4.25Z" />
    </svg>
  );
}

export function FileIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M4 1.5h5L13 5.5v8A1.5 1.5 0 0 1 11.5 15h-7.5A1.5 1.5 0 0 1 2.5 13.5v-10A2 2 0 0 1 4.5 1.5H4Zm5 1v3a1 1 0 0 0 1 1h2.5L9 2.5Z"
      />
    </svg>
  );
}

export function ChevronRight({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M3.5 2 7 5l-3.5 3v-6Z" />
    </svg>
  );
}

export function EyeIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5S1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

export function EyeOffIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M2 2l12 12M6.5 6.5a2 2 0 0 0 2.5 2.5M3 5.5C2 6.4 1.5 7.4 1.5 8s2.5 5 6.5 5c1 0 1.9-.2 2.7-.5m2-1.4c1.1-.9 1.8-1.9 1.8-2.6 0-.6-2.5-5-6.5-5-.6 0-1.1.1-1.7.2" />
    </svg>
  );
}

/** Icona "+": usata per il bottone "new proposal" accanto al refresh nel tree. */
export function PlusIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M8 3.5v9" />
      <path d="M3.5 8h9" />
    </svg>
  );
}

/** Icona "check" per il bottone Apply. */
export function CheckIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

/** Icona "archive box" per il bottone Archive. */
export function ArchiveIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect x="2" y="3" width="12" height="3" rx="0.5" />
      <path d="M3 6v6.5A1 1 0 0 0 4 13.5h8a1 1 0 0 0 1-1V6" />
      <path d="M6.5 8.5h3" />
    </svg>
  );
}

/** Icona "regen": ciclo + sparkle. Usata per il bottone "rigenera con Claude"
 *  accanto ai file design/tasks nel tree OpenSpec. */
export function RegenIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M13 3.5v3h-3" />
      <path d="M13 6.5A5.5 5.5 0 1 0 13.5 10" />
      <path d="M3 13.5l1-1m0 0l1 1m-1-1v-1.5" />
    </svg>
  );
}

/** Icona "proposal": lampadina — il file `proposal.md` di un change OpenSpec. */
export function ProposalIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M5.5 10.5c-1.2-.9-2-2.3-2-3.9A4.5 4.5 0 0 1 12.5 6.6c0 1.6-.8 3-2 3.9v1.5a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-1.5Z" />
      <path d="M6.5 14h3" />
      <path d="M8 4v3" />
    </svg>
  );
}

/** Icona "design": compasso/squadra — il file `design.md` di un change OpenSpec. */
export function DesignIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M8 2v8" />
      <path d="M8 2 4 13.5" />
      <path d="M8 2l4 11.5" />
      <circle cx="8" cy="10.5" r="1.5" />
    </svg>
  );
}

/** Icona "tasks": checklist — il file `tasks.md` di un change OpenSpec. */
export function TasksIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M3 3.5h2v2H3z" />
      <path d="M3 7.5h2v2H3z" />
      <path d="M3 11.5h2v2H3z" />
      <path d="M7 4.5h6" />
      <path d="M7 8.5h6" />
      <path d="M7 12.5h6" />
    </svg>
  );
}

/** Icona "spec": un libro aperto stilizzato. Usata dal rail sinistro e dalla
 *  testata della sidebar quando la modalità OpenSpec è disponibile. */
export function SpecIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M2 3.25A1.25 1.25 0 0 1 3.25 2H7v11H3.25A1.25 1.25 0 0 1 2 11.75V3.25Z" />
      <path d="M14 3.25A1.25 1.25 0 0 0 12.75 2H9v11h3.75A1.25 1.25 0 0 0 14 11.75V3.25Z" />
      <path d="M4 5h2M4 7.5h2M10 5h2M10 7.5h2" />
    </svg>
  );
}
