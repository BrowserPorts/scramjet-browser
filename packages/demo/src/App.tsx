import { css, type Component } from "dreamland/core";
import FlagEditor from "./components/FlagEditor";
import WebMcpStatus from "./components/WebMcpStatus";
import BrowserView from "./pages/BrowserView";
import RequestViewer from "./pages/RequestViewer";
import PlaygroundView from "./pages/Playground";
import SettingsView from "./pages/SettingsPage";
import { Omnibox } from "./pages/BrowserView";
import { requestsState } from "./pages/RequestViewer";
import { demoUiStore, type DemoTab } from "./store";

const App: Component = function () {
	const tabClass = (id: DemoTab) =>
		use(demoUiStore.activeTab).map(
			(tab) => `tab-button ${tab === id ? "active" : ""}`,
		);
	const panelClass = (id: DemoTab, extra: string) =>
		use(demoUiStore.activeTab).map(
			(tab) => `tab-panel ${extra} ${tab === id ? "active" : ""}`,
		);
	const isTab = (id: DemoTab) =>
		use(demoUiStore.activeTab).map((tab) => tab === id);

	return (
		<div>
			<div class="top-bar">
				<div class="tab-bar">
					<button
						class={tabClass("browser")}
						on:click={() => {
							demoUiStore.activeTab = "browser";
						}}
					>
						Browser
					</button>
					<button
						class={tabClass("requests")}
						on:click={() => {
							demoUiStore.activeTab = "requests";
						}}
					>
						Requests{" "}
						{use(requestsState.requests).map((requests) =>
							requests.length ? `(${requests.length})` : "",
						)}
					</button>
					<button
						class={tabClass("playground")}
						on:click={() => {
							demoUiStore.activeTab = "playground";
						}}
					>
						Playground
					</button>
					<button
						class={tabClass("settings")}
						on:click={() => {
							demoUiStore.activeTab = "settings";
						}}
					>
						Settings
					</button>
					{isTab("browser").andThen(<Omnibox />)}
				</div>
				<div class="top-actions">
					<WebMcpStatus />
					<FlagEditor inline={true} />
				</div>
			</div>
			<div class={panelClass("browser", "browser-panel")}>
				<BrowserView active={isTab("browser")} />
			</div>
			<div class={panelClass("requests", "requests-panel")}>
				<RequestViewer active={isTab("requests")} />
			</div>
			<div class={panelClass("playground", "playground-panel")}>
				<PlaygroundView active={isTab("playground")} />
			</div>
			<div class={panelClass("settings", "settings-tab")}>
				<SettingsView />
			</div>
		</div>
	);
};

App.style = css`
	@import url("https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0");

	:scope {
		width: 100vw;
		height: 100vh;
		display: flex;
		flex-direction: column;
		margin: 0;
		overflow: hidden;
		position: absolute;
		top: 0;
		left: 0;

		padding: 0;
		background: black;
		box-sizing: border-box;
	}
	.material-symbols-outlined {
		font-family: "Material Symbols Outlined";
		font-weight: normal;
		font-style: normal;
		font-size: 11px;
		line-height: 1;
		letter-spacing: normal;
		text-transform: none;
		display: inline-block;
		white-space: nowrap;
		word-wrap: normal;
		direction: ltr;
		-webkit-font-smoothing: antialiased;
	}
	.top-bar {
		display: flex;
		align-items: stretch;
		gap: 0;
		margin-bottom: 0;
		border-bottom: 1px solid #4a4a4a;
		background: #0f0f0f;
	}
	.tab-bar {
		display: flex;
		flex: 1;
		align-items: stretch;
		gap: 0;
	}
	.tab-button {
		border: 1px solid transparent;
		border-bottom: 0;
		background: transparent;
		color: #a8a8a8;
		padding: 0.24em 0.62em;
		border-radius: 0;
		cursor: pointer;
		font-size: 0.84em;
		line-height: 1.2;
		min-height: 28px;
		margin: 0;
		white-space: nowrap;
		display: inline-flex;
		align-items: center;
	}
	.tab-button:hover {
		background: #181818;
		color: #d0d0d0;
	}
	.tab-button.active {
		background: #1f1f1f;
		color: #fff;
		border-color: #4a4a4a;
		margin-bottom: -1px;
	}
	.top-actions {
		display: flex;
		align-items: center;
		gap: 0.45em;
		margin-left: auto;
		padding: 0 0.35em;
		min-height: 28px;
	}
	.tab-panel {
		flex: 1;
		width: 100%;
		min-width: 0;
		min-height: 0;
		display: none;
	}
	.tab-panel.active {
		display: flex;
	}
	.requests-panel {
		flex-direction: column;
	}
	.playground-panel {
		width: 100%;
		min-width: 0;
		min-height: 0;
	}
	.settings-tab {
		width: 100%;
		min-width: 0;
		min-height: 0;
	}
`;
export default App;
