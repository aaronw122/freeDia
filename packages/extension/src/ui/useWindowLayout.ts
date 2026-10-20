import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	clampRect,
	defaultRect,
	expandedRect,
	type Rect,
	type ResizeEdge,
	resizeRect,
	type Viewport,
	type WindowLayout,
	type WindowStore,
} from "./layout";

function currentViewport(): Viewport {
	return { width: window.innerWidth, height: window.innerHeight };
}

export interface WindowControls {
	rect: Rect;
	expanded: boolean;
	toggleExpanded(): void;
	startDrag(event: ReactPointerEvent<HTMLElement>): void;
	startResize(edge: ResizeEdge, event: ReactPointerEvent<HTMLElement>): void;
}

export function useWindowLayout(store: WindowStore): WindowControls {
	const [viewport, setViewport] = useState(currentViewport);
	const [layout, setLayout] = useState<WindowLayout>(() => ({
		rect: defaultRect(currentViewport()),
		expanded: false,
	}));
	const latest = useRef(layout);
	latest.current = layout;
	const touched = useRef(false);

	useEffect(() => {
		let live = true;
		void store.load().then((saved) => {
			if (live && saved && !touched.current) setLayout(saved);
		});
		return () => {
			live = false;
		};
	}, [store]);

	useEffect(() => {
		const onResize = () => setViewport(currentViewport());
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const rect = layout.expanded
		? expandedRect(viewport)
		: clampRect(layout.rect, viewport);

	const commit = (next: WindowLayout) => {
		touched.current = true;
		latest.current = next;
		setLayout(next);
		void store.save(next);
	};

	const track = (
		event: ReactPointerEvent<HTMLElement>,
		next: (dx: number, dy: number) => Rect,
	) => {
		event.preventDefault();
		touched.current = true;
		const target = event.currentTarget;
		const { pointerId, clientX, clientY } = event;
		target.setPointerCapture?.(pointerId);
		const move = (moveEvent: PointerEvent) => {
			const updated = {
				rect: next(moveEvent.clientX - clientX, moveEvent.clientY - clientY),
				expanded: false,
			};
			latest.current = updated;
			setLayout(updated);
		};
		const end = () => {
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", end);
			target.removeEventListener("pointercancel", end);
			commit(latest.current);
		};
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", end);
		target.addEventListener("pointercancel", end);
	};

	return {
		rect,
		expanded: layout.expanded,
		toggleExpanded() {
			commit({
				rect: clampRect(latest.current.rect, viewport),
				expanded: !latest.current.expanded,
			});
		},
		startDrag(event) {
			if (event.button !== 0) return;
			if (event.target instanceof Element && event.target.closest("button")) {
				return;
			}
			const start = rect;
			track(event, (dx, dy) =>
				clampRect({ ...start, x: start.x + dx, y: start.y + dy }, viewport),
			);
		},
		startResize(edge, event) {
			if (event.button !== 0) return;
			const start = rect;
			track(event, (dx, dy) => resizeRect(start, edge, dx, dy, viewport));
		},
	};
}
