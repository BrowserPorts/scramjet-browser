import type { ScramjetMinimalConfig } from "@/minimal/client";

/** A document a frame builds from markup its host sent, at a URL it never loads from */
export type FrameDocument = {
	/** Where the document is, in the codec's space; its <base> points here */
	url: string;
	/** Its markup, already decoded with its real charset */
	html: string;
	/** What document.referrer reads; empty when unset */
	referrer?: string;
};

/** Session history around one document, which the host keeps across the documents it built */
export type FrameHistory = {
	/** Entries before this document */
	before: number;
	/** Entries after it, which a traversal back left in place */
	after: number;
};

/** What a frame boot stub receives in its host's welcome, beside the port and the plugin payload */
export type FrameWelcome = {
	/** The runtime's own source, which the stub runs, and which workers and nested frames start from */
	runtime: string;
	/** The client's settings; the frame turns native routes off itself */
	config: ScramjetMinimalConfig;
	document: FrameDocument;
	/** The feature policy every frame inside this one carries */
	allow?: string;
	history?: FrameHistory;
};

/** What the stub leaves for the runtime it started: the link's port and the welcome */
export type FrameHandoff = {
	port: MessagePort;
	payload: unknown;
	frame: FrameWelcome;
};

/** A navigation the frame asks its host to make, which builds a new document */
export type FrameNavigation = {
	url: string;
	method?: string;
	headers?: [string, string][];
	body?: ArrayBuffer | null;
	/** Replaces the current history entry instead of adding one */
	replace?: boolean;
};

/**
 * The frame's channel to its host, beside the transport on the same link. Each description is
 * [args, result], as @mercuryworkshop/rpc channels are described.
 */
export type FrameChannel = {
	/** Loads another document into this frame */
	navigate: [FrameNavigation];
	/** Moves through the host's history by documents, as history.go does past this document */
	traverse: [{ delta: number }];
	/**
	 * A new link for a frame inside this one, numbered by this frame, with what its stub starts
	 * from. `html` is the markup of a srcdoc frame; without it the host loads the navigation.
	 */
	connect: [
		{ id: number; navigation: FrameNavigation; html?: string },
		{ port: MessagePort; payload: unknown; frame: FrameWelcome },
	];
};

/** What the host calls on a frame over the same channel */
export type FrameLocal = {
	/** A frame inside this one, by the number this frame gave it, navigated itself */
	child: [{ id: number; navigation: FrameNavigation }];
};
