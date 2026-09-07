export {};

declare global {
	type WebMcpJsonSchema = {
		type?: string;
		properties?: Record<string, WebMcpJsonSchema>;
		required?: string[];
		enum?: Array<string | number | boolean | null>;
		description?: string;
		minimum?: number;
		maximum?: number;
		items?: WebMcpJsonSchema;
		additionalProperties?: boolean | WebMcpJsonSchema;
		[key: string]: unknown;
	};

	interface ToolAnnotations {
		readOnlyHint?: boolean;
		untrustedContentHint?: boolean;
	}

	interface ToolExecuteCallbackOptions {
		signal: AbortSignal;
	}

	interface ModelContextTool {
		name: string;
		title?: string;
		description: string;
		inputSchema?: WebMcpJsonSchema;
		annotations?: ToolAnnotations;
		execute: (
			input: Record<string, unknown>,
			options: ToolExecuteCallbackOptions,
		) => unknown | Promise<unknown>;
	}

	interface ModelContextRegisterToolOptions {
		signal?: AbortSignal;
		exposedTo?: string[];
	}

	interface ModelContextGetToolOptions {
		fromOrigins?: string[];
	}

	interface ModelContextExecuteToolOptions {
		signal?: AbortSignal;
	}

	interface RegisteredTool {
		name: string;
		title: string;
		description: string;
		inputSchema?: WebMcpJsonSchema;
		annotations?: ToolAnnotations;
		origin: string;
		window: Window;
	}

	interface ModelContext extends EventTarget {
		registerTool(
			tool: ModelContextTool,
			options?: ModelContextRegisterToolOptions,
		): Promise<void>;
		getTools(options?: ModelContextGetToolOptions): Promise<RegisteredTool[]>;
		executeTool(
			tool: RegisteredTool,
			input?: object | string,
			options?: ModelContextExecuteToolOptions,
		): Promise<string>;
		ontoolchange: ((this: ModelContext, ev: Event) => unknown) | null;
	}

	interface Document {
		readonly modelContext?: ModelContext;
	}
}
