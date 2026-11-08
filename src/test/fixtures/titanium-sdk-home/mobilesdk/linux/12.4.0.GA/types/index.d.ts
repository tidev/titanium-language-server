/// <reference path="base.d.ts" />

declare namespace Titanium {
	namespace UI {
		class Label {
			text: string;
			color: string;
		}
		function createLabel (parameters?: Partial<Label>): Label;
	}
}
