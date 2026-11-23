import { Array_isArray, Object_keys } from "@/shared/snapshot";

export type ScramjetStorageType = "localStorage" | "sessionStorage";

export type ScramjetStorageMutation =
	| {
			type: "setItem";
			storageType: ScramjetStorageType;
			origin: string;
			key: string;
			value: string;
	  }
	| {
			type: "removeItem";
			storageType: ScramjetStorageType;
			origin: string;
			key: string;
	  }
	| {
			type: "clear";
			storageType: ScramjetStorageType;
			origin: string;
	  };

export type ScramjetSerializedStorageState = Partial<
	Record<ScramjetStorageType, Record<string, Record<string, string>>>
>;

export type ScramjetStorageContext = {
	url: URL;
	origin: string;
	storageType: ScramjetStorageType;
};

export type ScramjetStorageApiContext = {
	url: URL;
	origin: string;
};

export type ScramjetIndexedDBStorageAdapter = {
	open?(
		context: ScramjetStorageApiContext,
		name: string,
		version: number | undefined
	): IDBOpenDBRequest | undefined;
	deleteDatabase?(
		context: ScramjetStorageApiContext,
		name: string
	): IDBOpenDBRequest | undefined;
	databaseName?(
		context: ScramjetStorageApiContext,
		name: string,
		operation: "open" | "deleteDatabase"
	): string;
	displayName?(context: ScramjetStorageApiContext, name: string): string;
};

export type ScramjetCacheStorageAdapter = {
	cacheName?(
		context: ScramjetStorageApiContext,
		name: string,
		operation: "open" | "has" | "delete"
	): string;
	request?(
		context: ScramjetStorageApiContext,
		req: unknown,
		operation:
			| "match"
			| "add"
			| "addAll"
			| "put"
			| "matchAll"
			| "keys"
			| "delete"
	): RequestInfo;
};

export type ScramjetStorageArea = {
	getItem(context: ScramjetStorageContext, key: string): string | null;
	setItem(
		context: ScramjetStorageContext,
		key: string,
		val: string
	): boolean;
	removeItem(context: ScramjetStorageContext, key: string): boolean;
	clear(context: ScramjetStorageContext): boolean;
	key(context: ScramjetStorageContext, index: number): string | null;
	length(context: ScramjetStorageContext): number;
	keys?(context: ScramjetStorageContext): string[];
};

export type ScramjetStorageManager = {
	localStorage?: ScramjetStorageArea;
	sessionStorage?: ScramjetStorageArea;
	indexedDB?: ScramjetIndexedDBStorageAdapter;
	cacheStorage?: ScramjetCacheStorageAdapter;
	dump?(): ScramjetSerializedStorageState;
	load?(state: ScramjetSerializedStorageState): boolean;
	applyMutation?(
		mutation: ScramjetStorageMutation | ScramjetStorageMutation[]
	): boolean | Promise<boolean>;
};

type SyncStorageMutation = (
	mutation: ScramjetStorageMutation
) => boolean | Promise<boolean>;

function cloneState(
	state: Record<string, Record<string, string>>
): Record<string, Record<string, string>> {
	const clone: Record<string, Record<string, string>> = {};
	for (const origin of Object_keys(state)) {
		clone[origin] = { ...state[origin] };
	}
	return clone;
}

export class ScramjetStorageJar implements ScramjetStorageManager {
	readonly localStorage: ScramjetStorageArea;
	readonly sessionStorage: ScramjetStorageArea;
	private state: ScramjetSerializedStorageState;
	private readonly syncMutation: SyncStorageMutation | null;

	constructor(
		state: ScramjetSerializedStorageState = {},
		syncMutation: SyncStorageMutation | null = null
	) {
		this.state = {
			localStorage: cloneState(state.localStorage ?? {}),
			sessionStorage: cloneState(state.sessionStorage ?? {}),
		};
		this.syncMutation = syncMutation;
		this.localStorage = this.createArea("localStorage");
		this.sessionStorage = this.createArea("sessionStorage");
	}

	dump(): ScramjetSerializedStorageState {
		return {
			localStorage: cloneState(this.state.localStorage ?? {}),
			sessionStorage: cloneState(this.state.sessionStorage ?? {}),
		};
	}

	load(state: ScramjetSerializedStorageState): boolean {
		this.state = {
			localStorage: cloneState(state.localStorage ?? {}),
			sessionStorage: cloneState(state.sessionStorage ?? {}),
		};
		return true;
	}

	async applyMutation(
		mutation: ScramjetStorageMutation | ScramjetStorageMutation[]
	): Promise<boolean> {
		const mutations = Array_isArray(mutation) ? mutation : [mutation];
		for (const entry of mutations) {
			this.applyLocalMutation(entry);
		}
		return true;
	}

	private createArea(storageType: ScramjetStorageType): ScramjetStorageArea {
		return {
			getItem: (context, key) =>
				this.areaFor(storageType, context.origin, false)?.[key] ?? null,
			setItem: (context, key, val) => {
				const mutation: ScramjetStorageMutation = {
					type: "setItem",
					storageType,
					origin: context.origin,
					key,
					value: val,
				};
				this.applyLocalMutation(mutation);
				this.sendMutation(mutation);
				return true;
			},
			removeItem: (context, key) => {
				const mutation: ScramjetStorageMutation = {
					type: "removeItem",
					storageType,
					origin: context.origin,
					key,
				};
				this.applyLocalMutation(mutation);
				this.sendMutation(mutation);
				return true;
			},
			clear: (context) => {
				const mutation: ScramjetStorageMutation = {
					type: "clear",
					storageType,
					origin: context.origin,
				};
				this.applyLocalMutation(mutation);
				this.sendMutation(mutation);
				return true;
			},
			key: (context, index) =>
				this.keysFor(storageType, context.origin)[index] ?? null,
			length: (context) => this.keysFor(storageType, context.origin).length,
			keys: (context) => this.keysFor(storageType, context.origin),
		};
	}

	private areaFor(
		storageType: ScramjetStorageType,
		origin: string,
		create: boolean
	): Record<string, string> | null {
		const bucket = this.state[storageType] ?? (create ? {} : undefined);
		if (!bucket) return null;
		this.state[storageType] = bucket;
		const area = bucket[origin] ?? (create ? {} : undefined);
		if (!area) return null;
		bucket[origin] = area;
		return area;
	}

	private keysFor(storageType: ScramjetStorageType, origin: string): string[] {
		return Object_keys(this.areaFor(storageType, origin, false) ?? {});
	}

	private applyLocalMutation(mutation: ScramjetStorageMutation): boolean {
		const area = this.areaFor(mutation.storageType, mutation.origin, true)!;
		if (mutation.type === "setItem") {
			area[mutation.key] = mutation.value;
			return true;
		}
		if (mutation.type === "removeItem") {
			delete area[mutation.key];
			return true;
		}
		for (const key of Object_keys(area)) {
			delete area[key];
		}
		return true;
	}

	private sendMutation(mutation: ScramjetStorageMutation): boolean {
		const result = this.syncMutation?.(mutation);
		if (typeof result === "object" && result !== null) {
			result.catch(() => false);
		}
		return true;
	}
}
