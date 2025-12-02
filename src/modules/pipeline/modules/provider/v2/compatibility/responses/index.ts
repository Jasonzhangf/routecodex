import { CompatibilityModuleFactory } from '../compatibility-factory.js';
import { ResponsesC4MCompatibility } from './c4m-responses-compatibility.js';

CompatibilityModuleFactory.registerModuleType('responses-c4m-compatibility', ResponsesC4MCompatibility as any);
CompatibilityModuleFactory.registerModuleType('responses:c4m', ResponsesC4MCompatibility as any);

export { ResponsesC4MCompatibility } from './c4m-responses-compatibility.js';
