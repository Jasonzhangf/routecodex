import { CompatibilityModuleFactory } from '../compatibility-factory.js';
import { ResponsesC4MCompatibility } from './c4m-responses-compatibility.js';

const RESPONSES_PROFILES = ['responses-c4m-compatibility', 'responses:c4m', 'responses:fc', 'responses:fai', 'responses:default'];
for (const profile of RESPONSES_PROFILES) {
  CompatibilityModuleFactory.registerModuleType(profile, ResponsesC4MCompatibility);
}

export { ResponsesC4MCompatibility } from './c4m-responses-compatibility.js';
