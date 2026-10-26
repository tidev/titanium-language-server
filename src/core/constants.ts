/**
 * Which constants a property takes, transcribed from Titanium's own API documentation.
 *
 * `@types/titanium` cannot answer this. Its generator drops the `constants` field the SDK apidoc
 * carries on each property, so `textAlign` is `string | number` and `TEXT_ALIGNMENT_CENTER` is
 * `number | string`, with nothing joining them. The pairing below is that field, copied by hand
 * from `tidev/titanium-sdk` for the properties a stylesheet commonly sets.
 *
 * It says which *family* of constants a property takes and nothing about which exist: a wildcard
 * is expanded against the project's own types, so a project on an older SDK is never offered a
 * constant its SDK does not have, and a named constant is offered only when those types declare it.
 *
 * Deliberately small. It is held to the standard of the namespace table in `core/tags.ts` — each
 * rule names the apidoc file it came from — and the e2e tier checks every family expands to at
 * least one constant the real package declares, so a rule that has drifted from the SDK fails there.
 */

export interface ConstantRule {
	/** The property, as a stylesheet or a view writes it */
	property: string;
	/**
	 * The types the rule is for, when two types take different constants for one property.
	 *
	 * Absent for a rule every type with the property shares — which is most of them, since the
	 * apidoc declares a property once on the type that introduces it and the rest inherit it.
	 */
	types?: string[];
	/** Fully qualified constants, where a trailing `*` is a family to expand */
	constants: string[];
	/** The apidoc file it was transcribed from, relative to the SDK repository */
	source: string;
}

export const CONSTANT_RULES: ConstantRule[] = [
	// declared on View, so every view has them
	{ property: 'width', constants: [ 'Titanium.UI.FILL', 'Titanium.UI.SIZE' ], source: 'apidoc/Titanium/UI/View.yml' },
	{ property: 'height', constants: [ 'Titanium.UI.FILL', 'Titanium.UI.SIZE' ], source: 'apidoc/Titanium/UI/View.yml' },
	{ property: 'hiddenBehavior', constants: [ 'Titanium.UI.HIDDEN_BEHAVIOR_INVISIBLE', 'Titanium.UI.HIDDEN_BEHAVIOR_GONE' ], source: 'apidoc/Titanium/UI/View.yml' },

	// the same family on Label, Button, TextField, TextArea, Picker and Switch
	{ property: 'textAlign', constants: [ 'Titanium.UI.TEXT_ALIGNMENT_*' ], source: 'apidoc/Titanium/UI/Label.yml' },
	{ property: 'verticalAlign', constants: [ 'Titanium.UI.TEXT_VERTICAL_ALIGNMENT_*' ], source: 'apidoc/Titanium/UI/Label.yml' },
	{ property: 'ellipsize', constants: [ 'Titanium.UI.TEXT_ELLIPSIZE_TRUNCATE_*' ], source: 'apidoc/Titanium/UI/Label.yml' },
	{ property: 'autoLink', constants: [ 'Titanium.UI.AUTOLINK_*' ], source: 'apidoc/Titanium/UI/Label.yml' },

	// text input. TextArea's apidoc gives keyboardType as KEYBOARD_*, which would also take in the
	// unrelated KEYBOARD_APPEARANCE_* family; every other type says KEYBOARD_TYPE_*, so that is used
	{ property: 'keyboardType', constants: [ 'Titanium.UI.KEYBOARD_TYPE_*' ], source: 'apidoc/Titanium/UI/TextField.yml' },
	{ property: 'keyboardAppearance', constants: [ 'Titanium.UI.KEYBOARD_APPEARANCE_*' ], source: 'apidoc/Titanium/UI/TextArea.yml' },
	{ property: 'returnKeyType', constants: [ 'Titanium.UI.RETURNKEY_*' ], source: 'apidoc/Titanium/UI/TextField.yml' },
	{ property: 'autocapitalization', constants: [ 'Titanium.UI.TEXT_AUTOCAPITALIZATION_*' ], source: 'apidoc/Titanium/UI/TextField.yml' },
	{ property: 'borderStyle', constants: [ 'Titanium.UI.INPUT_BORDERSTYLE_*' ], source: 'apidoc/Titanium/UI/TextField.yml' },
	{ property: 'clearButtonMode', constants: [ 'Titanium.UI.INPUT_BUTTONMODE_*' ], source: 'apidoc/Titanium/UI/TextField.yml' },
	{ property: 'leftButtonMode', constants: [ 'Titanium.UI.INPUT_BUTTONMODE_*' ], source: 'apidoc/Titanium/UI/TextField.yml' },
	{ property: 'rightButtonMode', constants: [ 'Titanium.UI.INPUT_BUTTONMODE_*' ], source: 'apidoc/Titanium/UI/TextField.yml' },

	// lists and windows
	{ property: 'separatorStyle', constants: [ 'Titanium.UI.TABLE_VIEW_SEPARATOR_STYLE_*' ], source: 'apidoc/Titanium/UI/TableView.yml' },
	{ property: 'extendEdges', constants: [ 'Titanium.UI.EXTEND_EDGE_*' ], source: 'apidoc/Titanium/UI/Window.yml' },
	{ property: 'orientationModes', constants: [ 'Titanium.UI.LANDSCAPE_*', 'Titanium.UI.PORTRAIT', 'Titanium.UI.UPSIDE_PORTRAIT' ], source: 'apidoc/Titanium/UI/Window.yml' },

	// the one property here whose constants differ by type
	{ property: 'scalingMode', types: [ 'Titanium.UI.ImageView' ], constants: [ 'Titanium.Media.IMAGE_SCALING_*' ], source: 'apidoc/Titanium/UI/ImageView.yml' },
	{ property: 'scalingMode', types: [ 'Titanium.Media.VideoPlayer' ], constants: [ 'Titanium.Media.VIDEO_SCALING_*' ], source: 'apidoc/Titanium/Media/VideoPlayer.yml' }
];

/**
 * The constants a property takes on the given types, as a stylesheet writes them.
 *
 * Written under `Ti` rather than `Titanium`, which is what nearly every stylesheet uses and what
 * Alloy accepts alongside the long form.
 *
 * @param property - The property being written
 * @param types - The Titanium types it is being written onto
 * @param available - The constants the project's types declare in a namespace
 * @returns {string[]} The constants, in rule order and each once
 */
export function constantsFor (property: string, types: string[], available: (namespace: string) => string[]): string[] {
	const rules = CONSTANT_RULES.filter(rule => rule.property === property && (!rule.types || rule.types.some(type => types.includes(type))));
	const names = new Set<string>();

	for (const rule of rules) {
		for (const constant of rule.constants) {
			const dot = constant.lastIndexOf('.');
			const namespace = constant.slice(0, dot);
			const name = constant.slice(dot + 1);
			const declared = available(namespace);

			const matched = name.endsWith('*')
				? declared.filter(candidate => candidate.startsWith(name.slice(0, -1)))
				: declared.filter(candidate => candidate === name);

			for (const found of matched) {
				names.add(`${namespace.replace(/^Titanium\b/, 'Ti')}.${found}`);
			}
		}
	}

	return [ ...names ];
}

/**
 * The colour names offered to a colour. Every colour property is named for one, which is how they
 * are found: the types call each of them a string.
 */
export const COLOUR_NAMES = [
	'transparent', 'aqua', 'black', 'blue', 'brown', 'cyan', 'darkgray', 'fuchsia', 'gray', 'green', 'lightgray', 'lime',
	'magenta', 'maroon', 'navy', 'olive', 'orange', 'pink', 'purple', 'red', 'silver', 'teal', 'white', 'yellow'
];

/** What `layout` takes, which the types call a string and the apidoc lists in its description */
export const LAYOUTS = [ 'vertical', 'horizontal', 'composite' ];

/** The fixed values a property takes beside its constants, and whether they are written as strings */
export interface LiteralValues {
	values: string[];
	/** True for colours and layouts, which are strings; false for `true` and `false` */
	strings: boolean;
}

/**
 * The fixed values a property takes that are not constants: a colour's names, `layout`'s three,
 * and `true` and `false` for a boolean.
 *
 * Colours and layout go by the property's name, because the types carry nothing to tell them apart
 * from any other string. A boolean goes by its type, which does.
 *
 * @param property - The property, as a stylesheet or a view writes it
 * @param boolean - Whether the types say the property is a boolean
 * @returns {LiteralValues|undefined} The values, or nothing
 */
export function literalValuesFor (property: string, boolean: boolean): LiteralValues|undefined {
	if (/[Cc]olor$/.test(property)) {
		return { values: COLOUR_NAMES, strings: true };
	}
	if (property === 'layout') {
		return { values: LAYOUTS, strings: true };
	}
	if (boolean) {
		return { values: [ 'true', 'false' ], strings: false };
	}
	return undefined;
}
