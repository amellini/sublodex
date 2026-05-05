/** Inline SVG icons — flat, single-color (currentColor), Monokai-friendly. */

type IconProps = { size?: number; className?: string };

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
