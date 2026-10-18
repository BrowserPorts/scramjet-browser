import {
	type MethodsDefinition,
	type RpcDescription,
	RpcHelper,
} from "./helper";

const MessagePort_postMessage = MessagePort.prototype.postMessage;

/**
 * One MessagePort shared by several RPC channels. RpcHelper already namespaces its messages under
 * its id, so each channel (the transport, a storage plugin, an input plugin) gets its own helper on
 * the same port, and a message for a channel nobody opened is ignored.
 */
export class RpcLink {
	#channels = new Map<string, RpcHelper<any, any>>();

	constructor(public port: MessagePort) {
		port.onmessage = (event) => {
			const data = event.data;
			if (!data || typeof data !== "object") return;
			for (const id of Object.keys(data)) this.#channels.get(id)?.recieve(data);
		};
		port.onmessageerror = (event) => {
			console.error("RpcLink port messageerror (this should never happen!)", event);
		};
		port.start();
	}

	/** Opens a channel; methods answer the other side's calls, and the helper makes calls to it */
	channel<Local extends RpcDescription, Remote extends RpcDescription>(
		id: string,
		methods: MethodsDefinition<Local>
	): RpcHelper<Local, Remote> {
		if (this.#channels.has(id)) throw new Error(`RPC channel ${id} is already open`);
		const helper = new RpcHelper<Local, Remote>(methods, id, (data, transfer) =>
			MessagePort_postMessage.call(this.port, data, transfer as any)
		);
		this.#channels.set(id, helper);
		return helper;
	}

	close() {
		this.#channels.clear();
		this.port.close();
	}
}
