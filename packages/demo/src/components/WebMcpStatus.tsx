import { css, type Component } from "dreamland/core";
import { webmcpState } from "../webmcp";

const WebMcpStatus: Component = function () {
	const label = use(webmcpState.backend, webmcpState.toolCount).map(
		([backend, toolCount]) => {
			if (backend === "native") return `WebMCP native · ${toolCount}`;
			if (backend === "polyfill") return `WebMCP polyfill · ${toolCount}`;
			return "WebMCP off";
		},
	);
	const title = use(
		webmcpState.backend,
		webmcpState.error,
		webmcpState.toolCount,
	).map(([backend, error, toolCount]) => {
		if (error) return error;
		if (backend === "native") {
			return `Native document.modelContext with ${toolCount} demo tools.`;
		}
		if (backend === "polyfill") {
			return `Installed a document.modelContext polyfill with ${toolCount} demo tools. Enable chrome://flags/#enable-webmcp-testing for native WebMCP.`;
		}
		return "WebMCP tools are not available.";
	});

	return (
		<div
			class={use(webmcpState.backend, webmcpState.error).map(
				([backend, error]) => `webmcp-status ${error ? "error" : backend}`,
			)}
			title={title}
		>
			<span class="dot" aria-hidden="true"></span>
			<span>{label}</span>
		</div>
	);
};

WebMcpStatus.style = css`
	:scope {
		display: inline-flex;
		align-items: center;
		gap: 0.35em;
		padding: 0.22em 0.55em;
		border: 1px solid #2a2a2a;
		background: #141414;
		color: #a8a8a8;
		font-size: 0.72em;
		line-height: 1.2;
		white-space: nowrap;
		user-select: none;
	}
	.dot {
		width: 0.5em;
		height: 0.5em;
		border-radius: 50%;
		background: #6b7280;
	}
	:scope.native {
		color: #bbf7d0;
		border-color: #14532d;
		background: #052e16;
	}
	:scope.native .dot {
		background: #4ade80;
	}
	:scope.polyfill {
		color: #fde68a;
		border-color: #854d0e;
		background: #1c1408;
	}
	:scope.polyfill .dot {
		background: #fbbf24;
	}
	:scope.error,
	:scope.unavailable {
		color: #fecaca;
		border-color: #7f1d1d;
		background: #1c0808;
	}
	:scope.error .dot,
	:scope.unavailable .dot {
		background: #f87171;
	}
`;

export default WebMcpStatus;
