/** Dist floor. Sole home is `reasonable-defaults.json`. The string is the session file body. */

import defaults from "./reasonable-defaults.json" with { type: "json" };

export const reasonableDefaults = defaults;

/** Text of {@link reasonableDefaults} for `policyProgram`. `bindPolicy` takes the object. */
export const reasonableDefaultsSource: string = JSON.stringify(reasonableDefaults);
