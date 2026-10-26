/**
 * The Alloy runtime, as much of it as a controller reaches.
 *
 * Transcribed from `Alloy/lib/alloy/controllers/BaseController.js` and the controller template.
 * `@types/titanium` covers Titanium and stops there, with no `Alloy` namespace at all, so a
 * declaration naming `Alloy.Controller` without this resolves to an error type — and an error type
 * for `$` takes every view member down with it.
 *
 * **This file is loaded, not generated.** The language service reads it as a library root, exactly
 * the way it reads `@types/titanium`, so it is real TypeScript with real tooling rather than a
 * template literal inside a module. What *is* generated beside it is only what cannot be known
 * ahead of time: the keys of `Alloy.CFG`, the translation keys, and the names this project's own
 * `createController`, `createModel`, `createCollection` and `createWidget` accept. Those go into
 * the same `declare namespace Alloy` block and merge with this one.
 *
 * It ships in the package rather than living under `src/`, for two reasons that both bite. The
 * tsconfig include pattern would pull these ambient declarations into this project's own
 * compilation, so `Alloy` would be a global in our source. And `tsc` does not copy a `.d.ts` it
 * was given as input into `outDir`, so a file under `src/` would be missing from the build
 * entirely.
 *
 * Types are named where the referent is knowable and left `unknown` where it is not. A view member
 * really can be either a Titanium proxy or a controller — `<Require>` and `<Widget>` both put a
 * controller on `$` — so the union is the honest answer rather than either half of it. A model's
 * attributes are the user's own schema, and there `unknown` is the honest answer: a confident
 * wrong type is worse than an admitted gap, and the view members beside it carry the types that
 * matter.
 */

declare namespace Alloy {

	/**
	 * Anything that can sit on `$` under an id.
	 *
	 * A view element is a Titanium proxy, but `<Require src="…">` and `<Widget src="…">` both
	 * compile to a controller and are given ids like anything else, so both reach `$`.
	 */
	type ViewMember = Titanium.UI.View | Controller;

	/** The base class for Alloy controllers */
	interface Controller {
		/** The arguments the controller was created with */
		args: Record<string, unknown>;
		/** Every element of the view that has an id */
		__views: Record<string, ViewMember>;

		/** The view with this id, or the first top level view when none is given */
		getView (id?: string): ViewMember;
		/** Every element of the view that has an id */
		getViews (): Record<string, ViewMember>;
		getViewEx (options: { recurse: boolean }): ViewMember;
		/** The root view elements of this controller */
		getTopLevelViews (): ViewMember[];
		removeView (id: string): void;
		addTopLevelView (view: ViewMember): void;
		setParent (parent: ViewMember): void;

		getProxyProperty (name: string): unknown;
		getProxyPropertyEx (name: string, options: { recurse: boolean }): unknown;
		addProxyProperty (name: string, value: unknown): void;
		removeProxyProperty (name: string): void;

		/** The style a class or id resolves to in this controller's stylesheet */
		createStyle (options: object): Record<string, unknown>;
		addClass (proxy: Titanium.UI.View, classes: string | string[], options?: object): void;
		removeClass (proxy: Titanium.UI.View, classes: string | string[], options?: object): void;
		resetClass (proxy: Titanium.UI.View, classes?: string | string[], options?: object): void;
		updateViews (views: Record<string, unknown>): Controller;

		addListener (proxy: Titanium.UI.View, type: string, callback: (...args: unknown[]) => void): string;
		getListener (proxy?: Titanium.UI.View, type?: string): unknown[];
		removeListener (proxy?: Titanium.UI.View, type?: string, callback?: (...args: unknown[]) => void): void;

		destroy (): void;

		// Backbone.Events, which every controller is extended with
		on (event: string, callback: (...args: unknown[]) => void, context?: unknown): Controller;
		off (event?: string, callback?: (...args: unknown[]) => void, context?: unknown): Controller;
		once (event: string, callback: (...args: unknown[]) => void, context?: unknown): Controller;
		trigger (event: string, ...args: unknown[]): Controller;
		listenTo (other: unknown, event: string, callback: (...args: unknown[]) => void): Controller;
		stopListening (other?: unknown, event?: string, callback?: (...args: unknown[]) => void): Controller;
	}

	/** `<Require>` and `<Widget>` both compile to a controller */
	type Require = Controller;
	type Widget = Controller;

	/** A Backbone model, as `<Model instance="true">` puts one on `$` */
	interface Model {
		/**
		 * The model's own fields.
		 *
		 * The user's schema, declared in `app/models/<name>.js`, so there is nothing here to name
		 * it with — which is why `get` answers `unknown` rather than guessing.
		 */
		attributes: Record<string, unknown>;
		id: string | number;
		get (attribute: string): unknown;
		set (attribute: string | Record<string, unknown>, value?: unknown): Model;
		has (attribute: string): boolean;
		unset (attribute: string): Model;
		clear (): Model;
		toJSON (): Record<string, unknown>;
		fetch (options?: object): void;
		save (attributes?: Record<string, unknown>, options?: object): void;
		destroy (options?: object): void;
		on (event: string, callback: (...args: unknown[]) => void, context?: unknown): Model;
		off (event?: string, callback?: (...args: unknown[]) => void, context?: unknown): Model;
		trigger (event: string, ...args: unknown[]): Model;
	}

	/** A Backbone collection, as `<Collection instance="true">` puts one on `$` */
	interface Collection {
		models: Model[];
		length: number;
		at (index: number): Model;
		get (id: string | number): Model | undefined;
		add (models: Model | Model[] | Record<string, unknown> | Record<string, unknown>[], options?: object): Collection;
		remove (models: Model | Model[], options?: object): Collection;
		reset (models?: Model[] | Record<string, unknown>[], options?: object): Collection;
		each (iterator: (model: Model, index: number) => void): void;
		toJSON (): Record<string, unknown>[];
		fetch (options?: object): void;
		on (event: string, callback: (...args: unknown[]) => void, context?: unknown): Collection;
		off (event?: string, callback?: (...args: unknown[]) => void, context?: unknown): Collection;
		trigger (event: string, ...args: unknown[]): Collection;
	}
}
