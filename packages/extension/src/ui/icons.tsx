import type { ReactNode } from "react";

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.8}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export const PlusIcon = () => (
	<Icon>
		<path d="M12 5v14M5 12h14" />
	</Icon>
);

export const HistoryIcon = () => (
	<Icon>
		<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
		<path d="M3 3v5h5M12 7v5l3 2" />
	</Icon>
);

export const ExpandIcon = () => (
	<Icon>
		<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
	</Icon>
);

export const CollapseIcon = () => (
	<Icon>
		<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
	</Icon>
);

export const CloseIcon = ({ size }: { size?: number }) => (
	<Icon size={size ?? 16}>
		<path d="M18 6 6 18M6 6l12 12" />
	</Icon>
);

export const ArrowUpIcon = () => (
	<Icon>
		<path d="M12 19V5M5 12l7-7 7 7" />
	</Icon>
);

export const StopIcon = () => (
	<svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
		<rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
	</svg>
);

export const CopyIcon = () => (
	<Icon size={14}>
		<rect x="9" y="9" width="12" height="12" rx="2" />
		<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
	</Icon>
);

export const CheckIcon = () => (
	<Icon size={14}>
		<path d="M20 6 9 17l-5-5" />
	</Icon>
);

export const ChevronIcon = () => (
	<Icon size={12}>
		<path d="m6 9 6 6 6-6" />
	</Icon>
);

export const TextIcon = () => (
	<Icon size={14}>
		<path d="M4 7V5h16v2M9 19h6M12 5v14" />
	</Icon>
);

export const TrashIcon = () => (
	<Icon size={14}>
		<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
	</Icon>
);

export const BackIcon = () => (
	<Icon>
		<path d="m15 18-6-6 6-6" />
	</Icon>
);

export const AlertIcon = () => (
	<Icon size={16}>
		<circle cx="12" cy="12" r="9" />
		<path d="M12 8v4M12 16h.01" />
	</Icon>
);
